/**
 * Google Calendar account lifecycle: OAuth handshake, account/calendar
 * settings, and the periodic token-refresh sweep. Talks to Google directly
 * for the OAuth dance and listing user calendars; everything else delegates
 * to `calendarRepo`.
 *
 * Out of scope: pulling actual events (see `calendar.service.getGoogleEvents`
 * and `syncCalendars` — those still live in calendar.service for now and will
 * move to a `google-events.service.ts` in the next refactor pass). Watch
 * channels live in `google-watch.service.ts`.
 */
import { prisma } from '../../lib/prisma'
import { calendarRepo } from '../../repositories/calendar.repo'
import { refreshGoogleToken } from './google-token.service'
import { subscribeWatchChannel } from './google-watch.service'

// ---------------------------------------------------------------------------
// Account & calendar settings
// ---------------------------------------------------------------------------

export async function listAccounts(userId: string) {
  const accounts = await calendarRepo.findAccountsByUser(userId)

  // Lazy backfill: if any Google calendar is missing accessRole, fetch it once
  // from Google's calendarList. Old rows pre-date the column.
  const needsBackfill = accounts.some(
    (acc: any) =>
      acc.provider === 'google' &&
      (acc.calendars ?? []).some((c: any) => c.accessRole == null),
  )
  if (needsBackfill) {
    await backfillAccessRoles(accounts).catch((err) =>
      console.error('[CAL_BACKFILL] failed', err),
    )
    return calendarRepo.findAccountsByUser(userId)
  }

  return accounts
}

async function backfillAccessRoles(accounts: any[]): Promise<void> {
  for (const account of accounts) {
    if (account.provider !== 'google') continue
    const missing = (account.calendars ?? []).filter((c: any) => c.accessRole == null)
    if (!missing.length) continue

    let accessToken: string | undefined = account.accessToken
    if (account.expiresAt && new Date() >= new Date(account.expiresAt) && account.refreshToken) {
      const refreshed = await refreshGoogleToken(account.refreshToken)
      if (refreshed) {
        accessToken = refreshed.access_token
        await calendarRepo.updateAccount(account.id, {
          accessToken: refreshed.access_token,
          tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
        })
      }
    }
    if (!accessToken) continue

    const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) continue
    const data = (await res.json()) as { items?: Array<{ id: string; accessRole?: string }> }
    const byId = new Map((data.items ?? []).map((i) => [i.id, i.accessRole]))

    for (const cal of missing) {
      const role = byId.get(cal.providerCalendarId)
      if (role) {
        await calendarRepo.updateCalendar(cal.id, { accessRole: role }).catch(() => {})
      }
    }
  }
}

export async function deleteAccount(userId: string, id: string) {
  const account = await calendarRepo.findAccountById(id)
  if (!account || account.userId !== userId) return null
  await calendarRepo.deleteAccount(id)
  return true
}

export async function updateAccountSettings(
  userId: string,
  id: string,
  body: { defaultTargetCalendarId?: string | null },
) {
  const account = await calendarRepo.findAccountById(id)
  if (!account || account.userId !== userId) return null
  const updateData: Record<string, unknown> = {}
  if (body.defaultTargetCalendarId !== undefined) {
    updateData.defaultTargetCalendarId = body.defaultTargetCalendarId
  }
  if (!Object.keys(updateData).length) return account
  return calendarRepo.updateAccount(id, updateData)
}

export async function updateCalendar(
  userId: string,
  id: string,
  body: { isSelectedForSync?: boolean; isPrimary?: boolean; color?: string },
) {
  const calendar = await calendarRepo.findCalendarById(id)
  if (!calendar) return { error: 'not_found' as const }

  const account = await calendarRepo.findAccountByCalendarAccountId(calendar.calendarAccountId)
  if (!account || account.userId !== userId) return { error: 'unauthorized' as const }

  const updateData: Record<string, unknown> = {}
  if (body.isSelectedForSync !== undefined) updateData.isSelectedForSync = body.isSelectedForSync
  if (body.isPrimary !== undefined) updateData.isPrimary = body.isPrimary
  if (body.color !== undefined) updateData.color = body.color

  // If setting isPrimary=true, unset all other primary calendars
  if (body.isPrimary === true) {
    const accounts = await calendarRepo.findAllUserAccountsWithCalendars(userId)
    for (const acc of accounts) {
      for (const cal of acc.calendars) {
        if (cal.isPrimary && cal.id !== id) {
          await calendarRepo.updateCalendar(cal.id, { isPrimary: false })
        }
      }
    }
  }

  return { data: await calendarRepo.updateCalendar(id, updateData) }
}

// ---------------------------------------------------------------------------
// OAuth handshake
// ---------------------------------------------------------------------------

export function getGoogleOAuthUrl(): string | null {
  const clientId = process.env.AUTH_GOOGLE_ID
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI

  if (!clientId || !redirectUri) return null

  const scopes = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ].join(' ')

  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent&state=calendar_oauth`
}

/**
 * Complete the OAuth code-for-token exchange, persist the account+calendars,
 * and kick off the side effects (watch subscriptions, initial sync).
 *
 * `onAccountReady` is the hook the route uses to fire `syncCalendars` on the
 * fresh account without coupling this module to calendar.service. Passing it
 * as a callback keeps the dependency direction one-way (account → events,
 * never the reverse).
 */
export async function handleGoogleCallback(
  userId: string,
  code: string,
  onAccountReady?: (userId: string) => void | Promise<void>,
) {
  const clientId = process.env.AUTH_GOOGLE_ID
  const clientSecret = process.env.AUTH_GOOGLE_SECRET
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    return {
      error: 'not_configured' as const,
      detail: 'AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET or GOOGLE_CALENDAR_REDIRECT_URI missing',
    }
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text()
      console.error('[GOOGLE_CALLBACK] Token exchange failed:', errText)
      return { error: 'token_exchange_failed' as const, detail: errText }
    }

    const tokens = (await tokenResponse.json()) as {
      access_token: string
      refresh_token?: string
      expires_in: number
    }
    console.log('[GOOGLE_CALLBACK] token exchange OK')

    // Get user info from Google. If userinfo scope wasn't granted, fall back
    // to the calendar primary id (which is the user's email for Google).
    let userInfo: { email?: string; name?: string } = {}
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (userInfoRes.ok) {
      userInfo = (await userInfoRes.json()) as { email?: string; name?: string }
      console.log('[GOOGLE_CALLBACK] userinfo OK', userInfo.email)
    } else {
      const errText = await userInfoRes.text()
      console.warn(
        '[GOOGLE_CALLBACK] userinfo failed, will fall back to primary calendar id:',
        errText,
      )
    }

    if (!userInfo.email) {
      const primaryRes = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary',
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      )
      if (primaryRes.ok) {
        const primary = (await primaryRes.json()) as { id?: string; summary?: string }
        if (primary.id) {
          userInfo = { email: primary.id, name: primary.summary }
          console.log('[GOOGLE_CALLBACK] derived email from primary calendar', primary.id)
        }
      } else {
        const errText = await primaryRes.text()
        console.error('[GOOGLE_CALLBACK] primary calendar fallback failed:', errText)
      }
    }

    if (!userInfo.email) {
      return {
        error: 'userinfo_no_email' as const,
        detail: 'Could not determine Google account email from userinfo or primary calendar',
      }
    }

    // Upsert CalendarAccount
    const existingAccount = await calendarRepo.findAccountByProviderEmail(
      userId,
      'google',
      userInfo.email,
    )

    let account
    if (existingAccount) {
      account = await calendarRepo.updateAccount(existingAccount.id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || existingAccount.refreshToken,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      })
    } else {
      account = await calendarRepo.createAccount({
        userId,
        provider: 'google',
        providerAccountId: userInfo.email,
        providerEmail: userInfo.email,
        displayName: userInfo.name || userInfo.email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      })
    }
    console.log('[GOOGLE_CALLBACK] account upsert OK', account.id)

    // Fetch and store calendars from Google
    const calendarListRes = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    )
    if (!calendarListRes.ok) {
      const errText = await calendarListRes.text()
      console.error('[GOOGLE_CALLBACK] calendarList failed:', errText)
      return { error: 'calendar_list_failed' as const, detail: errText }
    }
    const calendarList = (await calendarListRes.json()) as {
      items?: Array<{
        id: string
        summary: string
        primary?: boolean
        backgroundColor?: string
        accessRole?: string
      }>
    }

    const upsertedCalendars: Array<{ id: string; isSelectedForSync: boolean | null | undefined }> = []
    if (calendarList.items) {
      for (const cal of calendarList.items) {
        const upserted = await calendarRepo.upsertCalendar(
          account.id,
          cal.id,
          { name: cal.summary, color: cal.backgroundColor, accessRole: cal.accessRole ?? null },
          {
            calendarAccountId: account.id,
            externalId: cal.id,
            name: cal.summary,
            color: cal.backgroundColor || null,
            isPrimary: cal.primary || false,
            isSelectedForSync: cal.primary || false,
            accessRole: cal.accessRole ?? null,
          },
        )
        upsertedCalendars.push({ id: upserted.id, isSelectedForSync: upserted.isSelectedForSync })
      }
    }
    console.log('[GOOGLE_CALLBACK] calendars upserted', upsertedCalendars.length)

    // Subscribe push-notification watch channels for synced calendars (fire-and-forget)
    for (const cal of upsertedCalendars) {
      if (cal.isSelectedForSync) {
        subscribeWatchChannel(cal.id).catch((err) =>
          console.error('[CAL_WATCH] subscribe on connect failed', err),
        )
      }
    }

    // Initial pull: hand off to the caller. The route wires this to
    // `calendarService.syncCalendars` so we don't import calendar.service here
    // (avoids circular dependency once events fetch/sync also moves out).
    if (onAccountReady) {
      Promise.resolve(onAccountReady(userId)).catch((err) =>
        console.error('[CAL_SYNC] initial pull on connect failed', err),
      )
    }

    return { data: account }
  } catch (err) {
    console.error('[GOOGLE_CALLBACK] unexpected error', err)
    return { error: 'callback_failed' as const, detail: (err as Error)?.message ?? String(err) }
  }
}

// ---------------------------------------------------------------------------
// Token refresh sweep (cron)
// ---------------------------------------------------------------------------

/**
 * Proactively refresh Google access tokens that expire in the next hour.
 * Reactive `ensureAccessToken` already covers the on-demand path, but if a
 * token expires between requests (e.g. overnight) the next push to Google
 * pays the latency of a refresh round-trip while the user waits. Running
 * this every 30 min keeps the pool warm.
 */
export async function refreshExpiringGoogleTokens(): Promise<{
  refreshed: number
  failed: number
  skipped: number
}> {
  const horizon = new Date(Date.now() + 60 * 60 * 1000)
  const accounts = await prisma.calendarAccount.findMany({
    where: {
      provider: 'google',
      refreshToken: { not: null },
      expiresAt: { lte: horizon },
    },
  })

  let refreshed = 0
  let failed = 0
  let skipped = 0
  for (const acc of accounts) {
    if (!acc.refreshToken) {
      skipped++
      continue
    }
    const tokens = await refreshGoogleToken(acc.refreshToken)
    if (!tokens) {
      failed++
      continue
    }
    await prisma.calendarAccount
      .update({
        where: { id: acc.id },
        data: {
          accessToken: tokens.access_token,
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        },
      })
      .catch((err) => {
        console.error('[CAL_TOKEN_REFRESH] update failed', { accountId: acc.id, err })
        failed++
      })
    refreshed++
  }
  return { refreshed, failed, skipped }
}
