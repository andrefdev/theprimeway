/**
 * Google OAuth access-token helpers, shared across every Google-talking
 * surface (events fetch, push to calendar, watch channels). Stored as plain
 * functions rather than a class so each consumer imports only what it needs
 * and unit tests can mock without `this` binding.
 *
 * On-demand refresh: `ensureAccessToken` checks the row's `expiresAt`, and
 * if expired (or in the next few seconds), exchanges the refresh token for
 * a new access token and writes both back. Returns the latest access token,
 * or null when the account has no token at all.
 */
import { prisma } from '../../lib/prisma'

/** Ensure a fresh access token for `accountId`. Mutates the DB on refresh. */
export async function ensureAccessToken(accountId: string): Promise<string | null> {
  const account = await prisma.calendarAccount.findUnique({ where: { id: accountId } })
  if (!account?.accessToken) return null

  const expired = account.expiresAt && new Date() >= account.expiresAt
  if (!expired) return account.accessToken
  if (!account.refreshToken) return account.accessToken // best-effort

  const refreshed = await refreshGoogleToken(account.refreshToken)
  if (!refreshed) return account.accessToken

  await prisma.calendarAccount.update({
    where: { id: accountId },
    data: {
      accessToken: refreshed.access_token,
      expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
    },
  })
  return refreshed.access_token
}

/**
 * Trade a refresh token for a new access token directly with Google's OAuth
 * endpoint. Returns null on any non-2xx response or network failure — the
 * caller decides whether to surface the error or fall back to the cached
 * (likely expired) token.
 */
export async function refreshGoogleToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number } | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.AUTH_GOOGLE_ID || '',
        client_secret: process.env.AUTH_GOOGLE_SECRET || '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) return null
    return res.json() as Promise<{ access_token: string; expires_in: number }>
  } catch {
    return null
  }
}
