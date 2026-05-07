import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { tasksQueries } from '@/features/tasks/queries'
import { calendarQueries } from '../queries'
import { useWorkingSessionsRange } from '@/features/scheduling/queries'
import { useUserTimezone } from '@/features/settings/hooks/use-user-timezone'
import { endOfLocalDayUtc, ymdToLocalDayUtc } from '@repo/shared/utils'
import { format, parseISO } from 'date-fns'
import type { Task } from '@repo/shared/types'
import type { CalendarEvent } from '@repo/shared/types'
import { googleColorIdToHex, colorTokenToHex } from '../lib/colors'

export interface EventAttendee {
  email: string
  displayName?: string
  responseStatus?: string
}

export interface CalendarItem {
  id: string
  title: string
  start: Date
  end: Date
  isAllDay: boolean
  color: string
  type: 'task' | 'event' | 'session'
  status?: string
  priority?: string
  task?: Task
  /** WorkingSession ID when type === 'session'. */
  sessionId?: string
  // Google event details (populated when type === 'event')
  googleEventId?: string
  googleCalendarId?: string
  calendarName?: string
  description?: string
  location?: string
  attendees?: EventAttendee[]
  hangoutLink?: string
  htmlLink?: string
  colorId?: string
  organizer?: { email?: string; displayName?: string }
  visibility?: string
  /** Google calendar access role: 'owner' | 'writer' | 'reader' | 'freeBusyReader'. */
  calendarAccessRole?: string | null
  /** True when this event lives on a read-only calendar (e.g. holidays). */
  isReadOnly?: boolean
}

/**
 * Merges WorkingSessions (the source of truth for "when a task runs") with
 * Google Calendar events into a unified list of CalendarItems. Tasks without
 * sessions live in the day list/backlog, not on the grid.
 */
export function useCalendarItems(dateRange: { from: string; to: string }) {
  const tz = useUserTimezone()
  const fromIso = useMemo(
    () => ymdToLocalDayUtc(dateRange.from, tz).toISOString(),
    [dateRange.from, tz],
  )
  const toIso = useMemo(
    () => endOfLocalDayUtc(ymdToLocalDayUtc(dateRange.to, tz), tz).toISOString(),
    [dateRange.to, tz],
  )

  const tasksQuery = useQuery(
    tasksQueries.list({
      filter: 'week',
      weekStart: dateRange.from,
      weekEnd: dateRange.to,
      limit: '500',
    }),
  )
  const eventsQuery = useQuery(
    calendarQueries.googleEvents({ timeMin: fromIso, timeMax: toIso }),
  )
  const sessionsQuery = useWorkingSessionsRange(fromIso, toIso)

  const items = useMemo<CalendarItem[]>(() => {
    const result: CalendarItem[] = []

    // 1) Working sessions → primary blocks on the calendar.
    const sessions = sessionsQuery.data ?? []
    const tasks = (tasksQuery.data?.data ?? []) as Task[]
    const taskById = new Map(tasks.map((t) => [t.id, t]))
    const colorMap: Record<string, string> = { high: 'red', medium: 'yellow', low: 'blue' }
    for (const s of sessions) {
      const start = parseISO(s.start)
      const end = parseISO(s.end)
      if (isNaN(start.getTime()) || isNaN(end.getTime())) continue
      const fullTask = s.taskId ? taskById.get(s.taskId) : undefined
      const title = s.task?.title ?? fullTask?.title ?? 'Working session'
      const priority = s.task?.priority ?? fullTask?.priority
      result.push({
        id: `session-${s.id}`,
        title,
        start,
        end,
        isAllDay: false,
        color: priority ? (colorMap[priority] ?? 'green') : 'green',
        type: 'session',
        status: fullTask?.status,
        priority: priority ?? undefined,
        task: fullTask,
        sessionId: s.id,
      })
    }

    // Google Calendar events. Backend currently returns Google's raw shape
    // (start.dateTime / end.dateTime / summary / id), not the typed CalendarEvent
    // shape — normalize defensively to handle both.
    const events = (eventsQuery.data?.data ?? []) as Array<CalendarEvent | Record<string, any>>
    for (const event of events) {
      const ev = event as any
      const startStr: string | undefined =
        ev.startTime ??
        ev.start?.dateTime ??
        (ev.start?.date ? `${ev.start.date}T00:00:00` : undefined)
      const endStr: string | undefined =
        ev.endTime ??
        ev.end?.dateTime ??
        (ev.end?.date ? `${ev.end.date}T23:59:59` : undefined)
      if (!startStr || !endStr) continue

      const start = parseISO(startStr)
      const end = parseISO(endStr)
      if (isNaN(start.getTime())) continue

      const id: string = ev.id ?? `${startStr}-${ev.summary ?? ev.title ?? 'event'}`
      const title: string = ev.title ?? ev.summary ?? '(untitled)'
      const isAllDay: boolean = ev.isAllDay ?? Boolean(ev.start?.date && !ev.start?.dateTime)
      const color: string = googleColorIdToHex(ev.colorId) ?? colorTokenToHex(ev.color) ?? colorTokenToHex(ev.calendarColor) ?? 'purple'

      const accessRole = (ev as any).calendarAccessRole as string | null | undefined
      const isReadOnly = Boolean(
        accessRole && accessRole !== 'owner' && accessRole !== 'writer',
      )

      result.push({
        id: `event-${id}`,
        title,
        start,
        end,
        isAllDay,
        color,
        type: 'event',
        googleEventId: ev.id,
        googleCalendarId: ev.calendarId,
        calendarName: ev.calendarName,
        description: ev.description,
        location: ev.location,
        attendees: Array.isArray(ev.attendees)
          ? (ev.attendees as any[]).map((a) => ({
              email: a.email,
              displayName: a.displayName,
              responseStatus: a.responseStatus,
            }))
          : undefined,
        hangoutLink: ev.hangoutLink,
        htmlLink: ev.htmlLink,
        colorId: ev.colorId,
        organizer: ev.organizer,
        visibility: ev.visibility,
        calendarAccessRole: accessRole ?? null,
        isReadOnly,
      })
    }

    return result.sort((a, b) => a.start.getTime() - b.start.getTime())
  }, [tasksQuery.data, eventsQuery.data, sessionsQuery.data])

  return {
    items,
    isLoading: tasksQuery.isLoading || sessionsQuery.isLoading,
    isError: tasksQuery.isError || eventsQuery.isError || sessionsQuery.isError,
  }
}

/** Get items for a specific day */
export function getItemsForDay(items: CalendarItem[], day: Date): CalendarItem[] {
  const dayStr = format(day, 'yyyy-MM-dd')
  return items.filter((item) => format(item.start, 'yyyy-MM-dd') === dayStr)
}
