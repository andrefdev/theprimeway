/**
 * Auth Service — Business logic layer
 *
 * Responsibilities:
 * - Credential validation, password hashing
 * - Token generation and verification
 * - OAuth provider user info resolution
 * - Orchestrate auth repository calls
 * - NO Prisma queries, NO HTTP concerns
 */
import { authRepository } from '../repositories/auth.repo'
import { userRepository } from '../repositories/user.repo'
import { signAccessToken, signRefreshToken } from '../middleware/auth'
import bcrypt from 'bcryptjs'
import * as jose from 'jose'
import { otpService } from './otp.service'
import { emailService } from './email.service'
import { channelsService } from './channels.service'

async function seedUserDefaults(userId: string) {
  try {
    await channelsService.seedDefaults(userId)
  } catch (e) {
    console.error('[auth] failed to seed default channels for', userId, e)
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface AuthTokens {
  token: string
  refreshToken: string
}

export interface AuthResult {
  token: string
  refreshToken: string
  user: {
    id: string
    name: string | null
    email: string
    image: string | null
    emailVerified: string | null
    role: string
  }
}

interface OAuthUserInfo {
  email: string
  name?: string
  image?: string
  providerAccountId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || 'dev-secret')
const SALT_ROUNDS = 12

function formatUser(user: { id: string; name: string | null; email: string | null; image: string | null; emailVerified: Date | null; role?: string }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email!,
    image: user.image,
    emailVerified: user.emailVerified?.toISOString() ?? null,
    role: user.role ?? 'user',
  }
}

async function generateTokens(userId: string, email: string): Promise<AuthTokens> {
  const [token, refreshToken] = await Promise.all([
    signAccessToken(userId, email),
    signRefreshToken(userId, email),
  ])
  return { token, refreshToken }
}

// Google's JWKS for verifying ID tokens (native mobile sign-in). jose caches
// and refreshes the keys in-process.
const googleJwks = jose.createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
)

// Accepted audiences for Google ID tokens. With @react-native-google-signin the
// idToken's `aud` is the webClientId (= AUTH_GOOGLE_ID). The iOS / Android client
// ids are also accepted when configured, for robustness across platforms.
const GOOGLE_AUDIENCES = [
  process.env.AUTH_GOOGLE_ID,
  process.env.AUTH_GOOGLE_IOS_ID,
  process.env.AUTH_GOOGLE_ANDROID_ID,
].filter((x): x is string => !!x)

async function getGoogleUserInfo(token: string): Promise<OAuthUserInfo | null> {
  // ID token (JWT — native mobile sign-in): verify signature + issuer +
  // audience against Google. A forged or wrong-audience token is rejected
  // (previously the payload was decoded WITHOUT any verification).
  if (token.split('.').length === 3) {
    if (GOOGLE_AUDIENCES.length === 0) {
      console.error('[google-oauth] AUTH_GOOGLE_ID missing — cannot verify id_token')
      return null
    }
    try {
      const { payload } = await jose.jwtVerify(token, googleJwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: GOOGLE_AUDIENCES,
      })
      const email = typeof payload.email === 'string' ? payload.email : null
      const sub = typeof payload.sub === 'string' ? payload.sub : null
      if (!email || !sub) return null
      return {
        email,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        image: typeof payload.picture === 'string' ? payload.picture : undefined,
        providerAccountId: sub,
      }
    } catch (err) {
      console.error('[google-oauth] id_token verification failed', err)
      return null
    }
  }
  // Access token (web implicit flow): Google validates the token and returns
  // the owning user's profile — only a token Google recognizes resolves here.
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const data = await res.json() as { email: string; name: string; picture: string; id: string }
  return { email: data.email, name: data.name, image: data.picture, providerAccountId: data.id }
}

// Cache Apple's JWKS in-process; jose handles its own caching/refresh.
const appleJwks = jose.createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys'),
)

// Accepted audiences for Apple ID tokens:
//   - AUTH_APPLE_ID: the Services ID (web "Sign in with Apple" → aud = Services ID)
//   - the native app bundle id: expo-apple-authentication on iOS issues an
//     id_token whose aud is the BUNDLE ID, not the Services ID. Verifying only
//     the Services ID broke native iOS sign-in (App Store rejection 2.1(a)).
const APPLE_AUDIENCES = [
  process.env.AUTH_APPLE_ID,
  process.env.AUTH_APPLE_BUNDLE_ID || 'com.indrox.theprimeway',
].filter((x): x is string => !!x)

async function getAppleUserInfo(idToken: string): Promise<OAuthUserInfo | null> {
  if (APPLE_AUDIENCES.length === 0) {
    console.error('[apple-oauth] AUTH_APPLE_ID env var missing — cannot verify id_token')
    return null
  }
  try {
    const { payload } = await jose.jwtVerify(idToken, appleJwks, {
      issuer: 'https://appleid.apple.com',
      audience: APPLE_AUDIENCES,
    })
    const email = typeof payload.email === 'string' ? payload.email : null
    const sub = typeof payload.sub === 'string' ? payload.sub : null
    if (!email || !sub) return null
    return { email, name: undefined, image: undefined, providerAccountId: sub }
  } catch (err) {
    console.error('[apple-oauth] id_token verification failed', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
class AuthService {
  async login(email: string, password: string): Promise<{ error: string } | AuthResult | { requiresVerification: true; email: string }> {
    const normalizedEmail = email.toLowerCase().trim()
    const user = await authRepository.findUserByEmail(normalizedEmail)

    if (!user?.passwordHash) return { error: 'Invalid credentials' }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) return { error: 'Invalid credentials' }

    if (!user.emailVerified) {
      await this.sendRegisterOtp(normalizedEmail)
      return { requiresVerification: true, email: normalizedEmail }
    }

    const tokens = await generateTokens(user.id, user.email!)
    return { ...tokens, user: formatUser(user) }
  }

  async register(name: string, email: string, password: string): Promise<{ error: string } | { requiresVerification: true; email: string }> {
    const normalizedEmail = email.toLowerCase().trim()

    const existing = await authRepository.findUserByEmail(normalizedEmail)
    if (existing) {
      if (existing.emailVerified) return { error: 'Email already registered' }
      // Unverified user — allow re-registration: update password, re-issue OTP
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
      await authRepository.updatePasswordByEmail(normalizedEmail, passwordHash)
      await this.sendRegisterOtp(normalizedEmail)
      return { requiresVerification: true, email: normalizedEmail }
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
    const newUser = await authRepository.createUserWithSettings({ name, email: normalizedEmail, passwordHash })
    await seedUserDefaults(newUser.id)
    await this.sendRegisterOtp(normalizedEmail)

    return { requiresVerification: true, email: normalizedEmail }
  }

  private async sendRegisterOtp(email: string): Promise<{ error: string } | { ok: true }> {
    const issued = await otpService.issue(email, 'register')
    if ('error' in issued) return issued
    try {
      await emailService.sendRegisterOtp(email, issued.code)
    } catch (e) {
      console.error('[auth] failed to send register OTP', e)
      return { error: 'Failed to send verification email' }
    }
    return { ok: true }
  }

  async verifyEmail(email: string, code: string): Promise<{ error: string } | AuthResult> {
    const normalizedEmail = email.toLowerCase().trim()
    const result = await otpService.verify(normalizedEmail, 'register', code)
    if ('error' in result) return result

    const user = await authRepository.markEmailVerified(normalizedEmail)
    await otpService.consume(result.id)

    // Fire-and-forget welcome email
    emailService.sendWelcome(normalizedEmail, user.name).catch((e) => {
      console.error('[auth] failed to send welcome email', e)
    })

    const tokens = await generateTokens(user.id, user.email!)
    return { ...tokens, user: formatUser(user) }
  }

  async resendOtp(email: string, purpose: 'register' | 'reset'): Promise<{ error: string } | { ok: true }> {
    const normalizedEmail = email.toLowerCase().trim()
    const user = await authRepository.findUserByEmail(normalizedEmail)

    if (purpose === 'register') {
      if (!user) return { ok: true } // don't leak
      if (user.emailVerified) return { error: 'Email already verified' }
      return this.sendRegisterOtp(normalizedEmail)
    }

    // reset
    if (!user?.passwordHash) return { ok: true }
    return this.sendResetOtp(normalizedEmail)
  }

  async forgotPassword(email: string): Promise<{ ok: true }> {
    const normalizedEmail = email.toLowerCase().trim()
    const user = await authRepository.findUserByEmail(normalizedEmail)
    if (user?.passwordHash) {
      await this.sendResetOtp(normalizedEmail)
    }
    return { ok: true } // always succeed to avoid email enumeration
  }

  private async sendResetOtp(email: string): Promise<{ error: string } | { ok: true }> {
    const issued = await otpService.issue(email, 'reset')
    if ('error' in issued) return issued
    try {
      await emailService.sendResetOtp(email, issued.code)
    } catch (e) {
      console.error('[auth] failed to send reset OTP', e)
      return { error: 'Failed to send reset email' }
    }
    return { ok: true }
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<{ error: string } | { ok: true }> {
    const normalizedEmail = email.toLowerCase().trim()
    const result = await otpService.verify(normalizedEmail, 'reset', code)
    if ('error' in result) return result

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS)
    await authRepository.updatePasswordByEmail(normalizedEmail, passwordHash)
    await otpService.consume(result.id)

    return { ok: true }
  }

  async requestAccountDeletion(
    userId: string,
    confirmEmail: string,
    password: string | undefined,
    reason: string | undefined,
  ): Promise<{ error: string } | { ok: true; hasPassword: boolean }> {
    const user = await authRepository.findUserAuthInfo(userId)
    if (!user?.email) return { error: 'User not found' }

    if (user.email.toLowerCase() !== confirmEmail.toLowerCase().trim()) {
      return { error: 'Email does not match your account' }
    }

    if (user.passwordHash) {
      if (!password) return { error: 'Password required' }
      const valid = await bcrypt.compare(password, user.passwordHash)
      if (!valid) return { error: 'Invalid password' }
    }

    if (reason) {
      console.log(`[ACCOUNT_DELETION_REASON] userId=${userId} reason=${reason.slice(0, 200)}`)
    }

    const issued = await otpService.issue(user.email, 'delete')
    if ('error' in issued) return issued

    try {
      await emailService.sendDeleteAccountOtp(user.email, issued.code)
    } catch (e) {
      console.error('[auth] failed to send delete-account OTP', e)
      return { error: 'Failed to send confirmation email' }
    }

    return { ok: true, hasPassword: !!user.passwordHash }
  }

  async confirmAccountDeletion(userId: string, code: string): Promise<{ error: string } | { ok: true }> {
    const user = await authRepository.findUserByIdMinimal(userId)
    if (!user?.email) return { error: 'User not found' }

    const result = await otpService.verify(user.email, 'delete', code)
    if ('error' in result) return result

    await otpService.consume(result.id)
    await userRepository.deleteUser(userId)

    return { ok: true }
  }

  async refreshToken(refreshTokenStr: string): Promise<{ error: string } | AuthTokens> {
    try {
      const { payload } = await jose.jwtVerify(refreshTokenStr, JWT_SECRET(), {
        issuer: 'theprimeway',
        audience: 'theprimeway',
      })

      if (payload.type !== 'refresh') return { error: 'Invalid token type' }

      const user = await authRepository.findUserByIdMinimal(payload.userId as string)
      if (!user?.email) return { error: 'User not found' }

      return generateTokens(user.id, user.email)
    } catch {
      return { error: 'Invalid or expired refresh token' }
    }
  }

  async logout(authHeader: string): Promise<{ error: string } | { success: true }> {
    if (!authHeader.startsWith('Bearer ')) return { error: 'Missing token' }

    const token = authHeader.slice(7)

    try {
      const { payload } = await jose.jwtVerify(token, JWT_SECRET(), {
        issuer: 'theprimeway',
        audience: 'theprimeway',
      })

      const crypto = await import('node:crypto')
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

      await authRepository.revokeToken(
        tokenHash,
        payload.userId as string,
        new Date((payload.exp || 0) * 1000),
      )

      return { success: true }
    } catch {
      return { error: 'Invalid token' }
    }
  }

  async getCurrentUser(userId: string) {
    const user = await authRepository.findUserById(userId)
    if (!user) return null

    return {
      ...user,
      emailVerified: user.emailVerified?.toISOString() ?? null,
    }
  }

  async oauthLogin(provider: string, accessToken: string, idToken?: string): Promise<{ error: string } | AuthResult> {
    let userInfo: OAuthUserInfo | null = null

    if (provider === 'google') {
      userInfo = await getGoogleUserInfo(accessToken)
    } else if (provider === 'apple') {
      if (!idToken) return { error: 'Apple login requires idToken' }
      userInfo = await getAppleUserInfo(idToken)
    }

    if (!userInfo?.email) return { error: 'Failed to get user info from provider' }

    // Check existing OAuth account
    const existingAccount = await authRepository.findOAuthAccount(provider, userInfo.providerAccountId)
    const accountData = { provider, providerAccountId: userInfo.providerAccountId, accessToken, idToken }

    let user

    if (existingAccount) {
      await authRepository.updateOAuthTokens(existingAccount.id, accessToken, idToken)
      const synced = await authRepository.syncUserFromOAuth(
        existingAccount.user.id,
        { name: userInfo.name, image: userInfo.image },
        { fillMissingNameOnly: true },
      )
      user = synced ?? existingAccount.user
    } else {
      const existingUser = await authRepository.findUserByEmail(userInfo.email)

      if (existingUser) {
        await authRepository.linkOAuthAccount(existingUser.id, accountData)
        const synced = await authRepository.syncUserFromOAuth(
          existingUser.id,
          { name: userInfo.name, image: userInfo.image },
          { fillMissingNameOnly: true },
        )
        user = synced ?? existingUser
      } else {
        user = await authRepository.createOAuthUserWithSettings(userInfo, accountData)
        await seedUserDefaults(user.id)
      }
    }

    const tokens = await generateTokens(user.id, user.email!)
    return { ...tokens, user: formatUser(user) }
  }
}

export const authService = new AuthService()
