/**
 * Google Calendar bulk read paths: pulling events from Google's API and
 * mirroring them into the local `CalendarEvent` cache, plus the cache-read
 * helpers the UI uses.
 *
 * Single-event CRUD (get/update/delete one event) lives in
 * `google-events.service.ts`. The split is intentional: those are user-
 * driven mutations against a single event id; this module is the
 * read/sync side that the gap-finder and the calendar UI both depend on.
 *
 * Sync strategy:
 *   1. Per selected calendar, prefer incremental sync via the
 *      `nextSyncToken` stored on the watch channel — Google returns only
 *      events that changed since the last call.
 *   2. On 410 GONE (token invalidated), clear it and retry as a full
 *      67-day window pull within the same call so the cache stays
 *      converged.
 *   3. Bootstrap a fresh `nextSyncToken` at the end so the next call can
 *      go incremental again. `fetchInitialSyncToken` lives in the watch
 *      service; we import it here.
 */
import { prisma } from '../../lib/prisma'
import { calendarRepo } from '../../repositories/calendar.repo'
import { syncService } from '../sync.service'
import { ensureAccessToken, refreshGoogleToken } from './google-token.service'
import { upsertCalendarEventCache } from './event-cache.service'
import { fetchInitialSyncToken } from './google-watch.service'

// ---------------------------------------------------------------------------
// Live fetch from Google (no caching) — feeds the AI tool that needs an
// authoritative view, plus the legacy read path some callers still use.
// ---------------------------------------------------------------------------

export async function getGoogleEvents(userId: string, timeMin: string, timeMax: string) {
  const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
  const allEvents: unknown[] = []

  for (const account of accounts) {
    let accessToken = account.accessToken
    const acct = account as any

    if (acct.expiresAt && new Date() >= new Date(acct.expiresAt) && account.refreshToken) {
      const refreshed = await refreshGoogleToken(account.refreshToken)
      if (refreshed) {
        accessToken = refreshed.access_token
        await calendarRepo.updateAccount(account.id, {
          accessToken: refreshed.access_token,
          tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
        })
      }
    }

    for (const cal of account.calendars) {
      try {
        const calAny = cal as any
        const externalId = calAny.externalId || calAny.providerCalendarId
        const eventsUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(externalId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=250`

        const res = await fetch(eventsUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })

        if (res.ok) {
          const data = (await res.json()) as { items?: unknown[] }
          if (data.items) {
            allEvents.push(
              ...data.items.map((event: any) => ({
                ...event,
                calendarId: externalId,
                internalCalendarId: cal.id,
                calendarName: cal.name,
                calendarColor: cal.color,
                calendarAccessRole: (cal as any).accessRole ?? null,
              })),
            )
          }
        }
      } catch (err) {
        console.error(`[GOOGLE_EVENTS] Error fetching calendar ${cal.id}:`, err)
      }
    }
  }

  return allEvents
}

// ---------------------------------------------------------------------------
// Cache sync (Google → local CalendarEvent rows)
// ---------------------------------------------------------------------------

/** Look up a Google account that has a refresh token, for an import flow. */
export async function importGoogleCalendar(userId: string) {
  return calendarRepo.findGoogleAccountWithRefreshToken(userId)
}

/**
 * Pull events from Google for the user's selected calendars and upsert them
 * into the local `CalendarEvent` cache. The scheduling engine reads that
 * cache as hard busy-block constraints, so without this, gap-finder sees
 * "nothing scheduled" even when the user has external meetings.
 *
 * - If `calendarId` is given, syncs only that one (must belong to user).
 * - Window: 7 days back to 60 days forward, expanding recurrences.
 * - Idempotent: relies on `upsertCalendarEventCache` (unique on
 *   calendarId + externalId).
 */
export async function syncCalendars(userId: string, calendarId?: string) {
  const accounts = await calendarRepo.findAccountsWithSyncCalendars(userId)
  if (accounts.length === 0) return { success: true, count: 0, eventsSynced: 0 }

  const timeMin = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  const timeMax = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString()

  let calendarsSynced = 0
  let eventsSynced = 0
  const errors: Array<{ calendarId: string; reason: string }> = []

  for (const account of accounts) {
    const accessToken = await ensureAccessToken(account.id)
    if (!accessToken) {
      for (const cal of account.calendars) {
        if (calendarId && cal.id !== calendarId) continue
        errors.push({ calendarId: cal.id, reason: 'no_access_token' })
      }
      continue
    }

    for (const cal of account.calendars) {
      if (calendarId && cal.id !== calendarId) continue
      const providerCalId = (cal as any).providerCalendarId || (cal as any).externalId
      if (!providerCalId) {
        errors.push({ calendarId: cal.id, reason: 'no_provider_id' })
        continue
      }

      // Look up an active watch channel; if it has a syncToken, prefer
      // incremental sync to avoid pulling the full 67-day window.
      const channel = await (prisma as any).calendarWatchChannel.findFirst({
        where: { calendarId: cal.id },
        orderBy: { createdAt: 'desc' },
      })

      try {
        const result = await pullCalendarEvents({
          calendarRowId: cal.id,
          providerCalId,
          accessToken,
          channel,
          timeMin,
          timeMax,
        })
        eventsSynced += result.eventsSynced
        calendarsSynced++
        if (result.error) errors.push({ calendarId: cal.id, reason: result.error })
      } catch (err) {
        errors.push({
          calendarId: cal.id,
          reason: `exception:${(err as Error).message?.slice(0, 80)}`,
        })
      }
    }
  }

  // Notify connected frontend tabs after sync completes.
  syncService.publish(userId, {
    type: 'calendar.event.updated',
    payload: {},
  })

  return {
    success: errors.length === 0,
    count: calendarsSynced,
    eventsSynced,
    errors: errors.length > 0 ? errors : undefined,
  }
}

/**
 * Pull events for a single calendar — incremental if the channel has a
 * `syncToken`, otherwise a full window pull. On 410 GONE (token invalidated
 * by Google) clears the token and retries as a full pull, then bootstraps a
 * fresh `nextSyncToken` at the end so subsequent calls can incremental again.
 */
async function pullCalendarEvents(args: {
  calendarRowId: string
  providerCalId: string
  accessToken: string
  channel: { id: string; syncToken: string | null } | null
  timeMin: string
  timeMax: string
}): Promise<{ eventsSynced: number; error?: string }> {
  const { calendarRowId, providerCalId, accessToken, channel, timeMin, timeMax } = args

  let pageToken: string | undefined
  let pages = 0
  let nextSyncToken: string | undefined
  let eventsSynced = 0
  let usingSyncToken = !!channel?.syncToken

  do {
    const params = new URLSearchParams({
      showDeleted: 'true',
      maxResults: '250',
    })
    if (usingSyncToken && channel?.syncToken && !pageToken) {
      params.set('syncToken', channel.syncToken)
    } else {
      params.set('singleEvents', 'true')
      params.set('orderBy', 'startTime')
      params.set('timeMin', timeMin)
      params.set('timeMax', timeMax)
    }
    if (pageToken) params.set('pageToken', pageToken)

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )

    // 410 GONE → syncToken invalidated. Clear it and retry from scratch as
    // a full window pull within this same call.
    if (res.status === 410 && usingSyncToken) {
      if (channel) {
        await (prisma as any).calendarWatchChannel
          .update({ where: { id: channel.id }, data: { syncToken: null } })
          .catch(() => undefined)
      }
      usingSyncToken = false
      pageToken = undefined
      pages = 0
      continue
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return {
        eventsSynced,
        error: `list_${res.status}:${txt.slice(0, 80)}`,
      }
    }

    const body = (await res.json()) as {
      items?: any[]
      nextPageToken?: string
      nextSyncToken?: string
    }
    for (const evt of body.items ?? []) {
      await upsertCalendarEventCache(calendarRowId, evt).catch((e) =>
        console.error('[CAL_SYNC] upsert error', {
          calendarId: calendarRowId,
          eventId: evt?.id,
          error: e,
        }),
      )
      eventsSynced++
    }
    pageToken = body.nextPageToken
    if (body.nextSyncToken) nextSyncToken = body.nextSyncToken
    pages++
  } while (pageToken && pages < 20)

  // Persist syncToken on the channel for the next incremental sync. If the
  // full-window pull didn't return one (Google withholds it on paginated
  // responses without a final non-paged page), bootstrap a fresh one.
  if (channel) {
    const tokenToStore =
      nextSyncToken ?? (await fetchInitialSyncToken(accessToken, providerCalId))
    if (tokenToStore) {
      await (prisma as any).calendarWatchChannel
        .update({ where: { id: channel.id }, data: { syncToken: tokenToStore } })
        .catch(() => undefined)
    }
  }

  return { eventsSynced }
}

// ---------------------------------------------------------------------------
// Local cache reads (no Google round-trip)
// ---------------------------------------------------------------------------

/**
 * List cached CalendarEvent rows in [from, to] for the user, in a shape the
 * web client already understands (the same defensive normalization in
 * `use-calendar-items.ts` handles both the raw Google shape and this
 * cache-derived shape). Triggers a background sync if no events are cached
 * AND the user has selected calendars — protects fresh users whose first
 * call would otherwise see "no events" until the next webhook fires.
 */
export async function listCachedEventsForUi(userId: string, from: Date, to: Date) {
  const events = await prisma.calendarEvent.findMany({
    where: {
      calendar: { account: { userId } },
      start: { lt: to },
      end: { gt: from },
      isDeclined: false,
    },
    include: {
      calendar: {
        select: { id: true, name: true, color: true, providerCalendarId: true, accessRole: true },
      },
    },
    orderBy: { start: 'asc' },
  })

  // Fire-and-forget pull when:
  //   (a) cache is empty (fresh user), or
  //   (b) most recent event was synced > 5 min ago (webhook may have failed
  //       silently or env without a public URL has no webhook at all).
  // The current request still returns whatever's cached without waiting; the
  // *next* request sees fresh data once the sync completes.
  const STALE_AFTER_MS = 5 * 60 * 1000
  let isStale = events.length === 0
  if (!isStale) {
    const newest = events.reduce((max, e: any) => {
      const t = e.syncedAt ? new Date(e.syncedAt).getTime() : 0
      return t > max ? t : max
    }, 0)
    isStale = newest === 0 || Date.now() - newest > STALE_AFTER_MS
  }
  if (isStale) {
    syncCalendars(userId).catch((err) =>
      console.error('[CAL_LIST] background sync failed', err),
    )
  }

  return events.map((e: any) => ({
    id: e.externalId,
    summary: e.title,
    title: e.title,
    startTime: e.start.toISOString(),
    endTime: e.end.toISOString(),
    start: { dateTime: e.start.toISOString() },
    end: { dateTime: e.end.toISOString() },
    isAllDay: e.isAllDay,
    isBusy: e.isBusy,
    colorId: e.colorId ?? null,
    description: e.description ?? null,
    location: e.location ?? null,
    htmlLink: e.htmlLink ?? null,
    hangoutLink: e.hangoutLink ?? null,
    visibility: e.visibility ?? null,
    recurringEventId: e.recurringEventId ?? null,
    recurrence: e.recurrence ?? [],
    attendees: e.attendees ?? null,
    organizer: e.organizer ?? null,
    calendarId: e.calendar?.providerCalendarId ?? null,
    internalCalendarId: e.calendar?.id ?? e.calendarId,
    calendarName: e.calendar?.name ?? null,
    calendarColor: e.calendar?.color ?? null,
    calendarAccessRole: e.calendar?.accessRole ?? null,
  }))
}

/** List cached CalendarEvent rows for [from, to] that are not declined. */
export async function listEventsInRange(userId: string, from: Date, to: Date) {
  return prisma.calendarEvent.findMany({
    where: {
      calendar: { account: { userId } },
      start: { lt: to },
      end: { gt: from },
      isDeclined: false,
    },
    select: {
      id: true,
      calendarId: true,
      externalId: true,
      title: true,
      start: true,
      end: true,
      isBusy: true,
      isAllDay: true,
    },
    orderBy: { start: 'asc' },
  })
}
