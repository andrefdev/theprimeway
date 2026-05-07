import { calendarRepo } from '../repositories/calendar.repo'
import { tasksRepository } from '../repositories/tasks.repo'
import { prisma } from '../lib/prisma'
import { generateObject } from 'ai'
import { taskModel } from '../lib/ai-models'
import { z } from 'zod'
import {
  localTimeToUtc,
  localYmd,
  ymdToLocalDayUtc,
} from '@repo/shared/utils'
import { collectBusyBlocks, computeGaps, getDayWindow } from './scheduling/gap-finder'
import { refreshGoogleToken } from './calendar/google-token.service'
import { upsertCalendarEventCache } from './calendar/event-cache.service'
import { syncCalendars } from './calendar/google-events-sync.service'

class CalendarService {


  /**
   * Free slots inside the user's working window for a date, that are at least
   * `duration` minutes long. Backed by gap-finder so the result is consistent
   * with what auto-schedule would actually pick: CalendarEvent cache (busy +
   * not declined) + existing WorkingSessions, expanded by the user's gap minutes.
   */
  async getFreeSlots(userId: string, date: string, duration: number) {
    const settings = await prisma.userSettings.findUnique({ where: { userId } })
    const tz = settings?.timezone ?? 'UTC'
    const gapMin = settings?.autoSchedulingGapMinutes ?? 5
    const day = ymdToLocalDayUtc(date, tz)

    const window = await getDayWindow(userId, null, day)
    if (!window) {
      // No working hours configured for this day → preserve legacy "no preferences" surface.
      const hasAnyHours = await prisma.workingHours.findFirst({ where: { userId } })
      if (!hasAnyHours) return { error: 'no_work_preferences' as const }
      return { freeSlots: [] }
    }

    const blocks = await collectBusyBlocks(userId, day, gapMin)
    const gaps = computeGaps(blocks, window.start, window.end)

    return {
      freeSlots: gaps
        .filter((g) => g.durationMinutes >= duration)
        .map((g) => ({
          start: g.start.toISOString(),
          end: g.end.toISOString(),
          durationMinutes: g.durationMinutes,
        })),
    }
  }

  /**
   * Free-time analytics across a date range. Backed by gap-finder.collectBusyBlocks
   * so the busy view matches what the scheduler sees: cached CalendarEvent rows
   * (excluding declined) plus existing WorkingSessions.
   */
  async analyzeFreeTime(
    userId: string,
    startDate: string,
    endDate: string,
    workStartHour = 8,
    workEndHour = 22,
  ) {
    const settings = await prisma.userSettings.findUnique({ where: { userId } })
    const tz = settings?.timezone ?? 'UTC'
    const gapMin = settings?.autoSchedulingGapMinutes ?? 0

    const totalWorkMinutesPerDay = (workEndHour - workStartHour) * 60
    const hh = `${String(workStartHour).padStart(2, '0')}:00`
    const eh = `${String(workEndHour).padStart(2, '0')}:00`

    const days: Array<{
      date: string
      totalFreeMinutes: number
      totalBusyMinutes: number
      longestFreeBlock: number
      freeSlots: Array<{ start: string; end: string; durationMinutes: number }>
      eventCount: number
    }> = []

    // Walk the range one local day at a time so each iteration anchors on a
    // unambiguous YMD in the user's tz.
    const startYmd = localYmd(new Date(startDate), tz)
    const endYmd = localYmd(new Date(endDate), tz)
    let cursor = ymdToLocalDayUtc(startYmd, tz)
    const stop = ymdToLocalDayUtc(endYmd, tz)

    while (cursor.getTime() <= stop.getTime()) {
      const dateStr = localYmd(cursor, tz)
      const dayStart = localTimeToUtc(cursor, hh, tz)
      const dayEnd = localTimeToUtc(cursor, eh, tz)

      const blocks = await collectBusyBlocks(userId, cursor, gapMin)
      const gaps = computeGaps(blocks, dayStart, dayEnd)

      const freeSlots = gaps.map((g) => ({
        start: g.start.toISOString(),
        end: g.end.toISOString(),
        durationMinutes: g.durationMinutes,
      }))
      const longestFreeBlock = freeSlots.reduce((m, s) => Math.max(m, s.durationMinutes), 0)
      const totalFreeMinutes = freeSlots.reduce((s, x) => s + x.durationMinutes, 0)
      // Count busy "events" inside the working window (events only, not sessions).
      const eventCount = blocks.filter(
        (b) => b.source === 'EVENT' && b.start < dayEnd && b.end > dayStart,
      ).length

      days.push({
        date: dateStr,
        totalFreeMinutes,
        totalBusyMinutes: Math.max(0, totalWorkMinutesPerDay - totalFreeMinutes),
        longestFreeBlock,
        freeSlots,
        eventCount,
      })

      // Advance to next local day at noon (DST-safe) and re-anchor.
      const nextYmd = localYmd(new Date(cursor.getTime() + 26 * 3600 * 1000), tz)
      if (nextYmd === dateStr) break // safety against bad tz / edge cases
      cursor = ymdToLocalDayUtc(nextYmd, tz)
    }

    // Build summary
    const avgFreeMinutesPerDay = days.length > 0
      ? Math.round(days.reduce((s, d) => s + d.totalFreeMinutes, 0) / days.length)
      : 0

    let busiestDay = days[0]?.date ?? startDate
    let freestDay = days[0]?.date ?? startDate
    let minFree = days[0]?.totalFreeMinutes ?? 0
    let maxFree = days[0]?.totalFreeMinutes ?? 0

    for (const d of days) {
      if (d.totalFreeMinutes < minFree) { minFree = d.totalFreeMinutes; busiestDay = d.date }
      if (d.totalFreeMinutes > maxFree) { maxFree = d.totalFreeMinutes; freestDay = d.date }
    }

    const totalFreeHours = Math.round(days.reduce((s, d) => s + d.totalFreeMinutes, 0) / 60 * 10) / 10

    return {
      days,
      summary: { avgFreeMinutesPerDay, busiestDay, freestDay, totalFreeHours },
    }
  }

  async createTimeBlock(
    userId: string,
    input: {
      title: string
      date: string
      startTime: string
      endTime: string
      description?: string
      color?: string
      timeZone?: string
      location?: string
      attendees?: { email: string }[]
      reminders?: {
        useDefault: boolean
        overrides?: { method: 'popup' | 'email'; minutes: number }[]
      }
      addGoogleMeet?: boolean
      calendarId?: string
    },
  ): Promise<{
    success: boolean
    eventId?: string
    hangoutLink?: string
    htmlLink?: string
    error?: string
  }> {
    // Get the user's primary Google Calendar account
    const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
    if (!accounts.length) return { success: false, error: 'no_google_account' }

    const account = accounts[0]!
    let accessToken = account.accessToken

    // Refresh token if needed
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

    // Pick calendar — caller can specify, otherwise primary
    let targetCalendarId = input.calendarId
    if (!targetCalendarId) {
      const primaryCal = account.calendars.find((c: any) => c.isPrimary) || account.calendars[0]
      if (!primaryCal) return { success: false, error: 'no_calendar' }
      const calAny = primaryCal as any
      targetCalendarId = calAny.externalId || calAny.providerCalendarId
    }

    // Reject writes to read-only calendars (holiday, contacts, weather, etc.)
    const targetCal = account.calendars.find(
      (c: any) =>
        c.providerCalendarId === targetCalendarId ||
        c.externalId === targetCalendarId,
    )
    const role = (targetCal as any)?.accessRole as string | null | undefined
    if (role && role !== 'owner' && role !== 'writer') {
      return { success: false, error: 'calendar_read_only' }
    }

    // Create the event
    const startDateTime = `${input.date}T${input.startTime}:00`
    const endDateTime = `${input.date}T${input.endTime}:00`

    const tz = input.timeZone || 'UTC'
    const eventBody: Record<string, unknown> = {
      summary: input.title,
      description: input.description || 'Time block created by ThePrimeWay',
      start: { dateTime: startDateTime, timeZone: tz },
      end: { dateTime: endDateTime, timeZone: tz },
      colorId: input.color || '9', // Blueberry
    }
    if (input.location) eventBody.location = input.location
    if (input.attendees?.length) eventBody.attendees = input.attendees
    if (input.reminders) eventBody.reminders = input.reminders
    if (input.addGoogleMeet) {
      eventBody.conferenceData = {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolution: { key: { type: 'hangoutsMeet' } },
        },
      }
    }

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId!)}/events`,
    )
    if (input.addGoogleMeet) url.searchParams.set('conferenceDataVersion', '1')

    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventBody),
      })

      if (!res.ok) {
        const error = await res.text()
        console.error('[TIME_BLOCK] Failed to create event:', error)
        // Google returns 403 on read-only calendars (holidays, contacts, etc.)
        if (res.status === 403 || /forbidden|read[- ]?only/i.test(error)) {
          if (targetCal && (!role || (role !== 'owner' && role !== 'writer'))) {
            await calendarRepo
              .updateCalendar((targetCal as any).id, { accessRole: 'reader' })
              .catch(() => {})
          }
          return { success: false, error: 'calendar_read_only' }
        }
        return { success: false, error: 'event_creation_failed' }
      }

      const event = (await res.json()) as Record<string, any>
      // Write-through to local cache so the UI sees the new event on its next
      // refetch — without this, the user has to wait for a Google webhook
      // (which never fires in dev) or a manual sync.
      if (targetCal && event.id) {
        await upsertCalendarEventCache((targetCal as any).id, event).catch((err) =>
          console.error('[TIME_BLOCK] cache write-through failed', err),
        )
      }
      return {
        success: true,
        eventId: event.id,
        hangoutLink: event.hangoutLink,
        htmlLink: event.htmlLink,
      }
    } catch (err) {
      console.error('[TIME_BLOCK] Error:', err)
      return { success: false, error: 'event_creation_failed' }
    }
  }


  async createHabitBlock(
    userId: string,
    input: {
      habitId: string
      habitName: string
      startTime: string
      endTime: string
      frequencyType: string
      weekDays?: string[]
      description?: string
      color?: string
    },
  ): Promise<{ success: boolean; eventId?: string; error?: string }> {
    // Get the user's primary Google Calendar account
    const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
    if (!accounts.length) return { success: false, error: 'no_google_account' }

    const account = accounts[0]!
    let accessToken = account.accessToken

    // Refresh token if needed
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

    // Find primary calendar
    const primaryCal = account.calendars.find((c: any) => c.isPrimary) || account.calendars[0]
    if (!primaryCal) return { success: false, error: 'no_calendar' }

    const calAny = primaryCal as any
    const calendarId = calAny.externalId || calAny.providerCalendarId

    // Build RRULE based on frequency
    let rrule = ''
    if (input.frequencyType === 'daily') {
      rrule = 'RRULE:FREQ=DAILY'
    } else if (input.frequencyType === 'weekly' && input.weekDays?.length) {
      rrule = `RRULE:FREQ=WEEKLY;BYDAY=${input.weekDays.join(',')}`
    } else {
      rrule = 'RRULE:FREQ=DAILY'
    }

    // Start from tomorrow
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateStr = tomorrow.toISOString().split('T')[0]

    const colorMap: Record<string, string> = {
      tomato: '11', flamingo: '4', tangerine: '6', banana: '5',
      sage: '2', basil: '10', peacock: '7', blueberry: '9',
      lavender: '1', grape: '3', graphite: '8',
    }

    const eventBody: Record<string, unknown> = {
      summary: `🔄 ${input.habitName}`,
      description: input.description || `Habit: ${input.habitName}`,
      start: { dateTime: `${dateStr}T${input.startTime}:00`, timeZone: 'America/New_York' },
      end: { dateTime: `${dateStr}T${input.endTime}:00`, timeZone: 'America/New_York' },
      recurrence: [rrule],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
    }

    if (input.color && colorMap[input.color]) {
      eventBody.colorId = colorMap[input.color]
    }

    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(eventBody),
        },
      )

      if (!res.ok) {
        const error = await res.text()
        console.error('[CALENDAR_HABIT_BLOCK] Failed to create recurring event:', error)
        return { success: false, error: 'event_creation_failed' }
      }

      const event = (await res.json()) as { id: string }
      // Recurring events: Google returns the master, but the cache stores
      // expanded singleEvents instances. Trigger a background sync so the UI
      // sees individual occurrences in the visible range.
      syncCalendars(userId).catch((err: unknown) =>
        console.error('[CALENDAR_HABIT_BLOCK] post-create sync failed', err),
      )
      return { success: true, eventId: event.id }
    } catch (err) {
      console.error('[CALENDAR_HABIT_BLOCK] Error:', err)
      return { success: false, error: 'event_creation_failed' }
    }
  }

  /**
   * AI-driven day plan. The AI no longer discovers gaps — it receives
   * pre-computed gaps from gap-finder (the same source the scheduler uses)
   * and only assigns tasks to those slots. This eliminates the timezone bugs
   * the previous implementation had and keeps suggestions consistent with what
   * autoSchedule would actually accept.
   */
  async generateTimeBlocks(userId: string, date: string) {
    const settings = await prisma.userSettings.findUnique({ where: { userId } })
    const tz = settings?.timezone ?? 'UTC'
    const gapMin = settings?.autoSchedulingGapMinutes ?? 5
    const day = ymdToLocalDayUtc(date, tz)

    const window = await getDayWindow(userId, null, day)
    if (!window) return { blocks: [], unscheduled: [] }
    const dayStart = window.start
    const dayEnd = window.end

    const allOpenTasks = await tasksRepository.findMany(userId, {
      status: 'open',
      archivedAt: null,
    })

    // Candidate tasks = scheduled today, due today, or backlog (no schedule).
    const candidateTasks = allOpenTasks.filter((t: any) => {
      const scheduled = t.scheduledDate ? new Date(t.scheduledDate) : null
      const due = t.dueDate ? new Date(t.dueDate) : null
      if (scheduled && scheduled >= dayStart && scheduled <= dayEnd) return true
      if (due && due >= dayStart && due <= dayEnd) return true
      if (!scheduled && !due) return true
      return false
    })
    if (!candidateTasks.length) return { blocks: [], unscheduled: [] }

    const blocks = await collectBusyBlocks(userId, day, gapMin)
    const gaps = computeGaps(blocks, dayStart, dayEnd)

    const gapsText = gaps.length
      ? gaps
          .map((g, i) => `- gap ${i + 1}: ${g.start.toISOString()} → ${g.end.toISOString()} (${g.durationMinutes} min)`)
          .join('\n')
      : '(No free gaps inside working hours)'

    const tasksText = candidateTasks
      .map((t: any) => {
        const duration = t.estimatedDurationMinutes ?? 30
        const tags = Array.isArray(t.tags) ? (t.tags as string[]).join(', ') : ''
        return `- [${t.id}] "${t.title}" | priority: ${t.priority || 'medium'} | estimated: ${duration} min | tags: ${tags || 'none'} | due: ${t.dueDate ? new Date(t.dueDate).toISOString().split('T')[0] : 'none'}`
      })
      .join('\n')

    const timeBlockSchema = z.object({
      blocks: z.array(
        z.object({
          taskId: z.string().describe('Exact task ID from the list'),
          taskTitle: z.string().describe('Task title for display'),
          startTime: z.string().describe('Start time as ISO 8601 (within one of the provided gaps)'),
          endTime: z.string().describe('End time as ISO 8601 (within one of the provided gaps)'),
          reason: z.string().describe('Brief reason for this time slot'),
        }),
      ),
      unscheduled: z.array(
        z.object({
          taskId: z.string(),
          taskTitle: z.string(),
          reason: z.string(),
        }),
      ),
    })

    const result = await generateObject({
      model: taskModel,
      schema: timeBlockSchema,
      prompt: `You are a productivity scheduling assistant. Place tasks into the user's actually-free gaps for the day. Do NOT invent slots outside the provided gaps and do NOT overlap.

DATE (user's local day): ${date}
USER TIMEZONE: ${tz}
WORKING WINDOW (UTC): ${dayStart.toISOString()} → ${dayEnd.toISOString()}

FREE GAPS (use only these — they already exclude calendar events and existing sessions):
${gapsText}

TASKS TO PLACE:
${tasksText}

RULES:
1. Each task must fit fully inside one gap. Do not split a task across gaps.
2. startTime/endTime must be valid ISO 8601 timestamps INSIDE the listed gaps.
3. If a task is longer than every available gap, add it to "unscheduled" with a clear reason.
4. Prefer placing higher-priority tasks earlier in the day.
5. Group tasks with similar tags when both fit in adjacent gaps.
6. Return the EXACT task IDs from the list — do not invent IDs.
7. Order "blocks" chronologically.`,
    })

    return result.object
  }

  /**
   * AI-driven slot suggestions for a single task. Now feeds the AI the same
   * pre-computed gaps that auto-schedule would see (CalendarEvent cache +
   * existing WorkingSessions, in the user's tz). The AI's job is to score
   * and rank — not to discover availability.
   */
  async findSmartSlots(userId: string, taskId: string, date: string) {
    const task = await tasksRepository.findById(userId, taskId)
    if (!task) return { error: 'task_not_found' as const }

    const settings = await prisma.userSettings.findUnique({ where: { userId } })
    const tz = settings?.timezone ?? 'UTC'
    const gapMin = settings?.autoSchedulingGapMinutes ?? 5
    const day = ymdToLocalDayUtc(date, tz)

    const window = await getDayWindow(userId, (task as any).channelId ?? null, day)
    if (!window) {
      return {
        slots: [],
        bestSlot: { startTime: '', endTime: '', reason: 'No working hours configured for this day.' },
      }
    }

    const blocksForDay = await collectBusyBlocks(userId, day, gapMin)
    const allGaps = computeGaps(blocksForDay, window.start, window.end)
    const taskDuration = (task as any).estimatedDurationMinutes ?? 30
    const fittingGaps = allGaps.filter((g) => g.durationMinutes >= taskDuration)
    if (fittingGaps.length === 0) {
      return {
        slots: [],
        bestSlot: {
          startTime: '',
          endTime: '',
          reason: `No gap of ${taskDuration}+ minutes available for this task today.`,
        },
      }
    }

    // Productivity context (which UTC hours the user historically completes tasks in).
    const completedTasks = await tasksRepository.findCompletedWithActualStart(userId, 50)
    const hourCounts: Record<number, number> = {}
    for (const t of completedTasks) {
      if (!t.actualStart) continue
      const h = new Date(t.actualStart).getUTCHours()
      hourCounts[h] = (hourCounts[h] || 0) + 1
    }
    const sortedHours = Object.entries(hourCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([h, c]) => `${String(h).padStart(2, '0')}:00 UTC (${c} tasks)`)
      .slice(0, 5)
    const productivitySummary = sortedHours.length
      ? `Most productive hours: ${sortedHours.join(', ')}`
      : 'No historical productivity data available.'

    const taskTags = Array.isArray((task as any).tags) ? ((task as any).tags as string[]).join(', ') : ''
    const gapsText = fittingGaps
      .map((g, i) => `- candidate ${i + 1}: ${g.start.toISOString()} → ${g.end.toISOString()} (${g.durationMinutes} min)`)
      .join('\n')

    const smartSlotsSchema = z.object({
      slots: z.array(
        z.object({
          startTime: z.string().describe('Start time in ISO 8601 (must be inside one of the candidate gaps)'),
          endTime: z.string().describe('End time in ISO 8601 (must fit within the same gap)'),
          score: z.number().min(0).max(100),
          reason: z.string(),
        }),
      ),
      bestSlot: z.object({
        startTime: z.string(),
        endTime: z.string(),
        reason: z.string(),
      }),
    })

    const result = await generateObject({
      model: taskModel,
      schema: smartSlotsSchema,
      prompt: `You are a smart scheduling assistant. Score the user's free slots for this task — do NOT invent slots outside the provided candidates.

DATE (user's local day): ${date}
USER TIMEZONE: ${tz}
WORKING WINDOW (UTC): ${window.start.toISOString()} → ${window.end.toISOString()}

TASK:
- Title: "${task.title}"
- Priority: ${(task as any).priority || 'medium'}
- Estimated duration: ${taskDuration} minutes
- Tags: ${taskTags || 'none'}

CANDIDATE GAPS (only suggest slots inside these — exact ISO 8601):
${gapsText}

USER PRODUCTIVITY PATTERN:
${productivitySummary}

RULES:
1. Each slot must fit fully inside one candidate gap.
2. Each slot must last exactly ${taskDuration} minutes.
3. Suggest 3 to ${Math.min(5, fittingGaps.length)} slots, ranked by score (highest first).
4. Score 0-100 considering: priority+morning bias, deep-work mid-morning bias, productivity pattern overlap, buffer around adjacent gaps.
5. The bestSlot equals the highest-scored slot.
6. Use the EXACT ISO 8601 timestamps from the candidate gaps as starting points; never go outside them.`,
    })

    return result.object
  }

  // ---- Task ↔ Google Calendar bidirectional sync --------------------------
  // OAuth token helpers and session-push live in
  // `services/calendar/google-token.service.ts` and
  // `services/calendar/session-push.service.ts` respectively. This file kept
  // them inline historically; they were extracted in the 2026-05-07 refactor.

  // -------------------------------------------------------------------------


  /**
   * List cached CalendarEvent rows in [from, to] for the user, in a shape the
   * web client already understands (the same defensive normalization in
   * `use-calendar-items.ts` handles both the raw Google shape and this
   * cache-derived shape). Triggers a background sync if no events are cached
   * AND the user has selected calendars — protects fresh users whose first
   * call would otherwise see "no events" until the next webhook fires.
   */
}

export const calendarService = new CalendarService()
