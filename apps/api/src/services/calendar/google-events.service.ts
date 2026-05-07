/**
 * Google Calendar event CRUD — single-event operations done directly against
 * Google's API on behalf of an authenticated user. The local
 * `CalendarEvent` cache is kept in sync via write-through so the UI sees
 * changes immediately rather than waiting for the next webhook tick.
 *
 * Bulk fetch + sync (events.list pagination, full calendar import) lives in
 * `calendar.service.getGoogleEvents` / `syncCalendars` and will move here in
 * a follow-up extraction.
 */
import { prisma } from '../../lib/prisma'
import { calendarRepo } from '../../repositories/calendar.repo'
import { refreshGoogleToken } from './google-token.service'
import { upsertCalendarEventCache } from './event-cache.service'

interface ResolvedCalendar {
  accessToken: string
  calendar: any
  account: any
}

/**
 * Resolve a Google calendar ID (the providerCalendarId/externalId Google
 * uses) to the local Calendar row + a fresh access token for its owning
 * account. Returns null if the calendar isn't connected for this user.
 */
async function resolveCalendarForUser(
  userId: string,
  calendarId: string,
): Promise<ResolvedCalendar | null> {
  const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
  for (const account of accounts) {
    const cal = (account.calendars as any[]).find(
      (c) => (c.providerCalendarId || c.externalId) === calendarId,
    )
    if (cal) {
      let accessToken = account.accessToken!
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
      return { accessToken, calendar: cal, account }
    }
  }
  return null
}

export async function getGoogleEvent(
  userId: string,
  calendarId: string,
  eventId: string,
): Promise<{ success: boolean; event?: any; error?: string }> {
  const ctx = await resolveCalendarForUser(userId, calendarId)
  if (!ctx) return { success: false, error: 'not_found' }
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
    )
    if (!res.ok) {
      return { success: false, error: `google_${res.status}` }
    }
    const event = await res.json()
    return { success: true, event }
  } catch (err) {
    console.error('[GET_EVENT] Error:', err)
    return { success: false, error: 'network_error' }
  }
}

export async function updateGoogleEvent(
  userId: string,
  calendarId: string,
  eventId: string,
  patch: {
    title?: string
    description?: string
    location?: string
    date?: string
    startTime?: string
    endTime?: string
    timeZone?: string
    colorId?: string
    attendees?: { email: string }[]
    addGoogleMeet?: boolean
    removeGoogleMeet?: boolean
    reminders?: {
      useDefault: boolean
      overrides?: { method: 'popup' | 'email'; minutes: number }[]
    }
    visibility?: 'default' | 'public' | 'private' | 'confidential'
  },
): Promise<{ success: boolean; event?: any; error?: string }> {
  const ctx = await resolveCalendarForUser(userId, calendarId)
  if (!ctx) return { success: false, error: 'not_found' }

  const body: Record<string, unknown> = {}
  if (patch.title !== undefined) body.summary = patch.title
  if (patch.description !== undefined) body.description = patch.description
  if (patch.location !== undefined) body.location = patch.location
  if (patch.colorId !== undefined) body.colorId = patch.colorId
  if (patch.attendees !== undefined) body.attendees = patch.attendees
  if (patch.reminders !== undefined) body.reminders = patch.reminders
  if (patch.visibility !== undefined) body.visibility = patch.visibility

  if (patch.date && patch.startTime && patch.endTime) {
    const tz = patch.timeZone || 'UTC'
    body.start = { dateTime: `${patch.date}T${patch.startTime}:00`, timeZone: tz }
    body.end = { dateTime: `${patch.date}T${patch.endTime}:00`, timeZone: tz }
  }

  let needsConferenceVersion = false
  if (patch.addGoogleMeet) {
    body.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolution: { key: { type: 'hangoutsMeet' } },
      },
    }
    needsConferenceVersion = true
  } else if (patch.removeGoogleMeet) {
    body.conferenceData = null
    needsConferenceVersion = true
  }

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  )
  if (needsConferenceVersion) url.searchParams.set('conferenceDataVersion', '1')

  try {
    const res = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errText = await res.text()
      console.error('[UPDATE_EVENT] Failed:', errText)
      return { success: false, error: 'event_update_failed' }
    }
    const event = (await res.json()) as Record<string, any>
    // Write-through to local cache so the UI sees the change immediately.
    if (ctx.calendar?.id && event?.id) {
      await upsertCalendarEventCache(ctx.calendar.id, event).catch((err) =>
        console.error('[UPDATE_EVENT] cache write-through failed', err),
      )
    }
    return { success: true, event }
  } catch (err) {
    console.error('[UPDATE_EVENT] Error:', err)
    return { success: false, error: 'network_error' }
  }
}

export async function deleteGoogleEvent(
  userId: string,
  calendarId: string,
  eventId: string,
): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveCalendarForUser(userId, calendarId)
  if (!ctx) return { success: false, error: 'not_found' }
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ctx.accessToken}` },
      },
    )
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      const errText = await res.text()
      console.error('[DELETE_EVENT] Failed:', errText)
      return { success: false, error: 'event_delete_failed' }
    }
    // Write-through: remove from local cache so the UI reflects the deletion.
    if (ctx.calendar?.id) {
      await prisma.calendarEvent
        .deleteMany({ where: { calendarId: ctx.calendar.id, externalId: eventId } })
        .catch((err) => console.error('[DELETE_EVENT] cache write-through failed', err))
    }
    return { success: true }
  } catch (err) {
    console.error('[DELETE_EVENT] Error:', err)
    return { success: false, error: 'network_error' }
  }
}
