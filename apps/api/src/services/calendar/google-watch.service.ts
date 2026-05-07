/**
 * Google Calendar Push Notifications (a.k.a. "watch channels").
 *
 * The lifecycle:
 *   1. `subscribeWatchChannel` — POST to /events/watch on Google. Google
 *      replies with a `resourceId` and `expiration` timestamp. We persist
 *      a `CalendarWatchChannel` row keyed by the `channelId` we generated,
 *      seeded with a fresh `nextSyncToken` so the very first webhook can
 *      use incremental sync rather than the 24h time-window fallback.
 *   2. Google fires `handleWatchNotification` when the calendar changes.
 *      We list events using the stored `syncToken`, upsert them into the
 *      local `CalendarEvent` cache, persist the new `nextSyncToken`, and
 *      publish a sync event so connected web clients refetch.
 *   3. `renewExpiringWatchChannels` runs daily (cron) — Google rejects
 *      channels older than 7 days; we re-subscribe before they expire,
 *      preserving the `syncToken` so incremental sync survives.
 *   4. `resubscribeWatchChannelsForUser` — admin/recovery path used after
 *      configuration changes (e.g. setting GOOGLE_CALENDAR_WEBHOOK_URL)
 *      to bootstrap channels for users that didn't have any.
 *
 * Spec & related: docs/CALENDAR_SYNC_SETUP.md.
 */
import { prisma } from '../../lib/prisma'
import { calendarRepo } from '../../repositories/calendar.repo'
import { syncService } from '../sync.service'
import { ensureAccessToken } from './google-token.service'
import { upsertCalendarEventCache } from './event-cache.service'

/**
 * Fetch a fresh `nextSyncToken` for a calendar via `events.list` with
 * `maxResults=1`. Google only returns `nextSyncToken` on the LAST page of a
 * paginated response, so a 1-result single-page request is the cheapest way
 * to bootstrap one. Returns null on any failure — caller can proceed without
 * a token (next webhook falls back to a 24h time window).
 */
export async function fetchInitialSyncToken(
  accessToken: string,
  providerCalId: string,
): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      maxResults: '1',
      singleEvents: 'true',
      showDeleted: 'true',
      orderBy: 'startTime',
      timeMin: new Date().toISOString(),
    })
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) return null
    const body = (await res.json()) as { nextSyncToken?: string; nextPageToken?: string }
    // If pagination is needed (rare for maxResults=1), Google withholds the
    // sync token until the final page; we don't loop because the payoff is
    // tiny — falling back to time-window pull on first webhook is fine.
    return body.nextSyncToken ?? null
  } catch {
    return null
  }
}

/**
 * Subscribe to push notifications for a given calendar.
 *
 * If `opts.initialSyncToken` is provided (e.g. preserved across a renewal),
 * it's stored on the new channel verbatim. Otherwise the function calls
 * `fetchInitialSyncToken` to bootstrap a fresh one.
 */
export async function subscribeWatchChannel(
  calendarId: string,
  opts: { initialSyncToken?: string | null } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const calendar = await calendarRepo.findCalendarById(calendarId)
  if (!calendar) return { ok: false, reason: 'calendar_not_found' }
  const account = await calendarRepo.findAccountByCalendarAccountId(calendar.calendarAccountId)
  if (!account) return { ok: false, reason: 'account_not_found' }

  const accessToken = await ensureAccessToken(account.id)
  if (!accessToken) return { ok: false, reason: 'no_access_token' }

  const webhookBase = process.env.GOOGLE_CALENDAR_WEBHOOK_URL || process.env.API_BASE_URL
  if (!webhookBase) return { ok: false, reason: 'no_webhook_url' }

  const channelId = crypto.randomUUID()
  const token = crypto.randomUUID()
  const providerCalId = (calendar as any).providerCalendarId || (calendar as any).externalId

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events/watch`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: channelId,
          type: 'web_hook',
          address: `${webhookBase.replace(/\/$/, '')}/api/calendar/google/webhook`,
          token,
        }),
      },
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { ok: false, reason: `watch_failed:${res.status}:${txt.slice(0, 120)}` }
    }
    const body = (await res.json()) as { resourceId: string; expiration: string }

    const syncToken =
      opts.initialSyncToken ?? (await fetchInitialSyncToken(accessToken, providerCalId))

    await (prisma as any).calendarWatchChannel.create({
      data: {
        calendarId: calendar.id,
        channelId,
        resourceId: body.resourceId,
        token,
        syncToken: syncToken ?? null,
        expiresAt: new Date(Number(body.expiration)),
      },
    })
    return { ok: true }
  } catch (err) {
    console.error('[CAL_WATCH] subscribe error', err)
    return { ok: false, reason: 'exception' }
  }
}

/** Handle an incoming webhook notification from Google. */
export async function handleWatchNotification(headers: {
  channelId?: string
  resourceId?: string
  resourceState?: string
  token?: string
}): Promise<{ ok: boolean; reason?: string }> {
  if (!headers.channelId) return { ok: false, reason: 'no_channel' }
  if (headers.resourceState === 'sync') return { ok: true } // initial handshake

  const channel = await (prisma as any).calendarWatchChannel.findUnique({
    where: { channelId: headers.channelId },
    include: { calendar: { include: { account: true } } },
  })
  if (!channel) return { ok: false, reason: 'channel_not_found' }
  if (channel.token && headers.token !== channel.token) return { ok: false, reason: 'bad_token' }

  const accessToken = await ensureAccessToken(channel.calendar.account.id)
  if (!accessToken) return { ok: false, reason: 'no_access_token' }

  const providerCalId =
    (channel.calendar as any).providerCalendarId || (channel.calendar as any).externalId
  const params = new URLSearchParams()
  if (channel.syncToken) params.set('syncToken', channel.syncToken)
  else params.set('timeMin', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
  params.set('showDeleted', 'true')
  params.set('maxResults', '100')

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) return { ok: false, reason: `list_failed:${res.status}` }
    const body = (await res.json()) as {
      items?: Array<any>
      nextSyncToken?: string
    }

    for (const evt of body.items || []) {
      await upsertCalendarEventCache(channel.calendarId, evt).catch((e) =>
        console.error('[CAL_WATCH] upsert event cache error', e),
      )
    }
    if (body.nextSyncToken) {
      await (prisma as any).calendarWatchChannel.update({
        where: { id: channel.id },
        data: { syncToken: body.nextSyncToken },
      })
    }
    // Notify connected frontend tabs so they refetch the calendar without polling
    syncService.publish(channel.calendar.account.userId, {
      type: 'calendar.event.updated',
      payload: {},
    })
    return { ok: true }
  } catch (err) {
    console.error('[CAL_WATCH] notification error', err)
    return { ok: false, reason: 'exception' }
  }
}

/**
 * Renew watch channels expiring within 24h.
 *
 * Preserves the existing `syncToken` so incremental sync is uninterrupted
 * across renewals. Without this, every renewal would reset to the 24h
 * fallback and miss events older than that window.
 */
export async function renewExpiringWatchChannels(): Promise<{ renewed: number; failed: number }> {
  const soon = new Date(Date.now() + 24 * 3600 * 1000)
  const channels = await (prisma as any).calendarWatchChannel.findMany({
    where: { expiresAt: { lte: soon } },
  })
  let renewed = 0
  let failed = 0
  for (const ch of channels) {
    const res = await subscribeWatchChannel(ch.calendarId, {
      initialSyncToken: ch.syncToken ?? null,
    })
    if (res.ok) {
      await (prisma as any).calendarWatchChannel.delete({ where: { id: ch.id } })
      renewed++
    } else {
      failed++
    }
  }
  return { renewed, failed }
}

/**
 * One-shot reactivation of push notifications for a user. For each
 * `isSelectedForSync` calendar, drops any existing watch channels that lack
 * a `syncToken` (or are already expired) and creates a fresh one with a
 * bootstrapped token. Channels that are healthy (have token, not expired)
 * are left alone.
 */
export async function resubscribeWatchChannelsForUser(
  userId: string,
): Promise<{ recreated: number; kept: number; failed: number }> {
  const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
  let recreated = 0
  let kept = 0
  let failed = 0
  const now = new Date()

  for (const account of accounts) {
    for (const cal of account.calendars) {
      const calId = (cal as any).id
      const isSelected = (cal as any).isSelectedForSync === true
      if (!isSelected) continue

      const existing = await (prisma as any).calendarWatchChannel.findFirst({
        where: { calendarId: calId },
        orderBy: { createdAt: 'desc' },
      })

      const healthy =
        existing && existing.syncToken && existing.expiresAt && existing.expiresAt > now
      if (healthy) {
        kept++
        continue
      }

      // Drop any stale channels for this calendar before creating a new one
      // so we don't accumulate dead rows.
      await (prisma as any).calendarWatchChannel
        .deleteMany({ where: { calendarId: calId } })
        .catch(() => undefined)

      const res = await subscribeWatchChannel(calId)
      if (res.ok) recreated++
      else failed++
    }
  }

  return { recreated, kept, failed }
}
