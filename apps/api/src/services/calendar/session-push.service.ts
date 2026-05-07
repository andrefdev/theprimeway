/**
 * Push WorkingSessions to (and remove from) Google Calendar.
 *
 * Each WorkingSession that should be visible on the user's external calendar
 * gets a corresponding Google event. The session row stores
 * `externalCalendarId` + `externalEventId` so we can later patch or delete
 * the same event when the session moves or vanishes.
 *
 * Calendar resolution order for a new push:
 *   1. Channel.timeboxToCalendarId (per-channel target)
 *   2. CalendarAccount.defaultTargetCalendarId (user-level default)
 *   3. The user's primary selected-for-sync calendar
 * If none resolve, the session stays local and we return `no_target_calendar`.
 *
 * All three functions are best-effort from the caller's POV — they return a
 * `{ ok, reason }` discriminated union instead of throwing, so a Google
 * outage doesn't block the local DB write that initiated the push.
 */
import { prisma } from '../../lib/prisma'
import { calendarRepo } from '../../repositories/calendar.repo'
import { ensureAccessToken } from './google-token.service'

export type PushResult =
  | { ok: true; eventId: string }
  | { ok: false; reason: string }

export type SimpleResult = { ok: boolean; reason?: string }

/** Push a WorkingSession to Google. No-op if it already has an externalEventId. */
export async function pushSessionToCalendar(sessionId: string): Promise<PushResult> {
  const session = await prisma.workingSession.findUnique({
    where: { id: sessionId },
    include: { task: true },
  })
  if (!session) return { ok: false, reason: 'session_not_found' }
  if (session.externalEventId) return { ok: true, eventId: session.externalEventId }

  // Try the channel binding first.
  let calendar: Awaited<ReturnType<typeof prisma.calendar.findUnique>> | null = null
  if (session.task?.channelId) {
    const channel = await prisma.channel.findUnique({ where: { id: session.task.channelId } })
    if (channel?.timeboxToCalendarId) {
      calendar = await prisma.calendar.findUnique({
        where: { id: channel.timeboxToCalendarId },
        include: { account: true },
      })
    }
  }

  // Fallback: account default / primary calendar for this user.
  if (!calendar) {
    const target = await calendarRepo.findTargetCalendarForUser(session.userId)
    if (!target) return { ok: false, reason: 'no_target_calendar' }
    calendar = await prisma.calendar.findUnique({
      where: { id: target.calendar.id },
      include: { account: true },
    })
  }
  if (!calendar) return { ok: false, reason: 'calendar_not_found' }

  const accessToken = await ensureAccessToken(calendar.calendarAccountId)
  if (!accessToken) return { ok: false, reason: 'no_access_token' }

  const userSettings = await prisma.userSettings.findUnique({
    where: { userId: session.userId },
    select: { timezone: true },
  })
  const tz = userSettings?.timezone ?? 'UTC'

  const body = {
    summary: session.task?.title ?? 'Working session',
    description: 'Auto-scheduled by ThePrimeWay',
    start: { dateTime: session.start.toISOString(), timeZone: tz },
    end: { dateTime: session.end.toISOString(), timeZone: tz },
    extendedProperties: { private: { theprimewaySessionId: session.id } },
  }
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.providerCalendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { ok: false, reason: `google_${res.status}:${txt.slice(0, 120)}` }
  }
  const data = (await res.json()) as { id?: string }
  if (!data.id) return { ok: false, reason: 'no_event_id' }

  await prisma.workingSession.update({
    where: { id: session.id },
    data: { externalCalendarId: calendar.id, externalEventId: data.id },
  })
  return { ok: true, eventId: data.id }
}

/** Remove a previously-pushed session from Google. Safe to call when unpushed. */
export async function removeSessionFromCalendar(sessionId: string): Promise<SimpleResult> {
  const session = await prisma.workingSession.findUnique({ where: { id: sessionId } })
  if (!session) return { ok: true }
  if (!session.externalEventId || !session.externalCalendarId) return { ok: true }
  const calendar = await prisma.calendar.findUnique({ where: { id: session.externalCalendarId } })
  if (!calendar) return { ok: false, reason: 'calendar_not_found' }
  const accessToken = await ensureAccessToken(calendar.calendarAccountId)
  if (!accessToken) return { ok: false, reason: 'no_access_token' }
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.providerCalendarId)}/events/${encodeURIComponent(session.externalEventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  )
  // 410 Gone / 404 are fine (already deleted on Google).
  if (!res.ok && res.status !== 410 && res.status !== 404) {
    return { ok: false, reason: `google_${res.status}` }
  }
  await prisma.workingSession
    .update({
      where: { id: session.id },
      data: { externalEventId: null, externalCalendarId: null },
    })
    .catch(() => undefined)
  return { ok: true }
}

/** Patch the existing event with the session's current start/end. If unpushed, push now. */
export async function updateSessionOnCalendar(sessionId: string): Promise<SimpleResult> {
  const session = await prisma.workingSession.findUnique({
    where: { id: sessionId },
    include: { task: true },
  })
  if (!session) return { ok: false, reason: 'session_not_found' }
  if (!session.externalEventId || !session.externalCalendarId) {
    const pushed = await pushSessionToCalendar(sessionId)
    return pushed.ok ? { ok: true } : { ok: false, reason: pushed.reason }
  }
  const calendar = await prisma.calendar.findUnique({ where: { id: session.externalCalendarId } })
  if (!calendar) return { ok: false, reason: 'calendar_not_found' }
  const accessToken = await ensureAccessToken(calendar.calendarAccountId)
  if (!accessToken) return { ok: false, reason: 'no_access_token' }

  const userSettings = await prisma.userSettings.findUnique({
    where: { userId: session.userId },
    select: { timezone: true },
  })
  const tz = userSettings?.timezone ?? 'UTC'

  const body = {
    start: { dateTime: session.start.toISOString(), timeZone: tz },
    end: { dateTime: session.end.toISOString(), timeZone: tz },
    summary: session.task?.title ?? 'Working session',
  }
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.providerCalendarId)}/events/${encodeURIComponent(session.externalEventId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { ok: false, reason: `google_${res.status}:${txt.slice(0, 120)}` }
  }
  return { ok: true }
}
