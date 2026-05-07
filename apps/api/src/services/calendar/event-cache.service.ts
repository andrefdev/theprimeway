/**
 * Mirror Google Calendar events into the local `CalendarEvent` cache.
 *
 * This row is the single source of truth that:
 *   - the scheduling engine reads as busy-block hard constraints
 *     (`gap-finder.collectBusyBlocks`)
 *   - the calendar UI reads via `/google/events` (post cache-mode migration)
 *
 * Both inbound paths feed it — the periodic sync (`syncCalendars`) and the
 * push webhook (`handleWatchNotification`). Putting the upsert here keeps
 * those callers from drifting on what fields land in the row.
 *
 * Deliberately skips events we created from a `WorkingSession` (marked via
 * `extendedProperties.private.theprimewaySessionId`). Those are already
 * rendered by the UI from the `WorkingSession` table and the scheduler
 * sees them via the session branch of `collectBusyBlocks` — caching them
 * again would double-render in the time grid.
 */
import { prisma } from '../../lib/prisma'

export async function upsertCalendarEventCache(calendarId: string, evt: any): Promise<void> {
  if (!evt?.id) return
  if (evt.status === 'cancelled') {
    await prisma.calendarEvent
      .deleteMany({ where: { calendarId, externalId: evt.id } })
      .catch(() => undefined)
    return
  }
  if (evt.extendedProperties?.private?.theprimewaySessionId) return
  const startStr = evt.start?.dateTime ?? evt.start?.date
  const endStr = evt.end?.dateTime ?? evt.end?.date
  if (!startStr || !endStr) return
  const start = new Date(startStr)
  const end = new Date(endStr)
  const isAllDay = !evt.start?.dateTime
  // Google `transparency: transparent` = marked as Available (free) → not busy
  const isBusy = (evt.transparency ?? 'opaque') === 'opaque'
  // declined: user's attendee status is 'declined'
  const selfAttendee = (evt.attendees ?? []).find((a: any) => a?.self === true)
  const isDeclined = selfAttendee?.responseStatus === 'declined'

  const recurrence: string[] = Array.isArray(evt.recurrence) ? evt.recurrence : []
  const attendees =
    Array.isArray(evt.attendees) && evt.attendees.length > 0 ? evt.attendees : null
  const organizer = evt.organizer ?? null

  await prisma.calendarEvent.upsert({
    where: { calendarId_externalId: { calendarId, externalId: evt.id } },
    update: {
      title: evt.summary ?? '(untitled)',
      start,
      end,
      isBusy,
      isDeclined,
      isAllDay,
      colorId: evt.colorId ?? null,
      description: evt.description ?? null,
      location: evt.location ?? null,
      htmlLink: evt.htmlLink ?? null,
      hangoutLink: evt.hangoutLink ?? null,
      visibility: evt.visibility ?? null,
      recurringEventId: evt.recurringEventId ?? null,
      recurrence,
      attendees,
      organizer,
      syncedAt: new Date(),
    },
    create: {
      calendarId,
      externalId: evt.id,
      title: evt.summary ?? '(untitled)',
      start,
      end,
      isBusy,
      isDeclined,
      isAllDay,
      colorId: evt.colorId ?? null,
      description: evt.description ?? null,
      location: evt.location ?? null,
      htmlLink: evt.htmlLink ?? null,
      hangoutLink: evt.hangoutLink ?? null,
      visibility: evt.visibility ?? null,
      recurringEventId: evt.recurringEventId ?? null,
      recurrence,
      attendees,
      organizer,
    },
  })
}
