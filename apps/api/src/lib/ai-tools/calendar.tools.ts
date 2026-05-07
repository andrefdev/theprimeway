import { tool } from 'ai'
import { z } from 'zod'
import { calendarService } from '../../services/calendar.service'
import { getGoogleEvents } from '../../services/calendar/google-events-sync.service'

export function calendarReadTools(userId: string) {
  return {
    listCalendarEvents: tool({
      description:
        'List calendar events between two ISO timestamps. Returns each event with its `id` and `calendarId` — use those to call updateCalendarEvent or deleteCalendarEvent.',
      inputSchema: z.object({
        from: z.string().describe('Start ISO datetime'),
        to: z.string().describe('End ISO datetime'),
      }),
      execute: async ({ from, to }) => {
        try {
          const events = await getGoogleEvents(userId, from, to)
          return {
            events: (events as any[]).slice(0, 50).map((e) => ({
              id: e.id,
              calendarId: e.calendarId,
              title: e.summary ?? e.title,
              start: e.start?.dateTime ?? e.start?.date ?? e.start,
              end: e.end?.dateTime ?? e.end?.date ?? e.end,
              location: e.location,
            })),
          }
        } catch (err: any) {
          return { error: err?.message ?? 'Failed to fetch events', events: [] }
        }
      },
    }),

    findFreeSlots: tool({
      description: 'Find free calendar slots on a given date that fit a minimum duration',
      inputSchema: z.object({
        date: z.string().describe('YYYY-MM-DD'),
        durationMinutes: z.number().describe('Minimum slot length in minutes'),
      }),
      execute: async ({ date, durationMinutes }) => {
        const res: any = await calendarService.getFreeSlots(userId, date, durationMinutes)
        return res
      },
    }),
  }
}

export function calendarClientTools() {
  return {
    createTimeBlock: tool({
      description:
        "Propose creating a calendar time block in the user's connected Google Calendar. Requires user approval AND requires the user to have a Google Calendar connected (Settings → Integrations). If the user has not connected Google yet, ask them to connect before proposing this.",
      inputSchema: z.object({
        title: z.string(),
        date: z.string().describe('YYYY-MM-DD'),
        startTime: z.string().describe('HH:MM (24h)'),
        endTime: z.string().describe('HH:MM (24h)'),
        description: z.string().optional(),
        timeZone: z.string().optional().describe('IANA timezone, e.g. America/Bogota. Defaults to user browser TZ.'),
      }),
    }),

    updateCalendarEvent: tool({
      description:
        'Propose updating an existing Google Calendar event (move it, rename, change description, location, etc.). Requires user approval. Use listCalendarEvents first to obtain `eventId` and `calendarId` — never invent them.',
      inputSchema: z.object({
        eventId: z.string().describe('Google Calendar event ID, from listCalendarEvents'),
        calendarId: z.string().describe('Internal calendar ID owning the event, from listCalendarEvents'),
        eventTitle: z.string().describe('Current title for display in the confirmation UI'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional(),
        location: z.string().optional(),
        date: z.string().optional().describe('New date YYYY-MM-DD (apply together with startTime/endTime)'),
        startTime: z.string().optional().describe('New start HH:MM (24h)'),
        endTime: z.string().optional().describe('New end HH:MM (24h)'),
        timeZone: z.string().optional().describe('IANA timezone. Defaults to user browser TZ.'),
        addGoogleMeet: z.boolean().optional(),
        removeGoogleMeet: z.boolean().optional(),
        visibility: z.enum(['default', 'public', 'private', 'confidential']).optional(),
      }),
    }),

    deleteCalendarEvent: tool({
      description:
        'Propose deleting an existing Google Calendar event. Requires user approval. Use listCalendarEvents first to obtain `eventId` and `calendarId`.',
      inputSchema: z.object({
        eventId: z.string(),
        calendarId: z.string(),
        eventTitle: z.string().describe('For display in the confirmation UI'),
      }),
    }),
  }
}
