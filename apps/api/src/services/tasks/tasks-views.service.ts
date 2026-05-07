/**
 * Calendar & Timeline read-only views over the user's tasks.
 *
 * Pure aggregation: shape the rows from `tasksRepository.findByDateRange`
 * into the structures the calendar grid and the day-timeline want. No
 * mutation, no Google sync, no AI.
 *
 * Date semantics: callers pass YYYY-MM-DD strings; the range is interpreted
 * as `[start T00:00Z, end T23:59:59.999Z]` UTC. After the 2026-05-07
 * normalization migration every `Task.scheduledDate` lives at UTC-midnight,
 * so this UTC-window query catches every task whose intent date falls
 * inside the window regardless of the user's timezone.
 */
import { tasksRepository } from '../../repositories/tasks.repo'
import type { Task } from '@prisma/client'

type TaskModel = Task & { weeklyGoal?: unknown }

/**
 * Tasks grouped by date for the month/week calendar grid. Every date in
 * `[start, end]` gets a (possibly empty) entry so the frontend doesn't
 * have to fill gaps. Each task lands in `allDay` if it has no specific
 * time slot (or `isAllDay` is set), otherwise in `timed`.
 */
export async function getCalendarView(
  userId: string,
  start: string,
  end: string,
): Promise<{ days: Record<string, { allDay: TaskModel[]; timed: TaskModel[] }> }> {
  const startDate = new Date(`${start}T00:00:00.000Z`)
  const endDate = new Date(`${end}T23:59:59.999Z`)

  const tasks = await tasksRepository.findByDateRange(userId, startDate, endDate)

  const days: Record<string, { allDay: TaskModel[]; timed: TaskModel[] }> = {}

  // Pre-fill every date in the range so the frontend always has an entry.
  const cursor = new Date(startDate)
  while (cursor <= endDate) {
    const key = cursor.toISOString().split('T')[0]!
    days[key] = { allDay: [], timed: [] }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  for (const task of tasks) {
    // Use scheduledDate first, fall back to dueDate.
    const dateSource = task.scheduledDate ?? task.dueDate
    if (!dateSource) continue
    const dateKey = new Date(dateSource).toISOString().split('T')[0]!

    if (!days[dateKey]) {
      days[dateKey] = { allDay: [], timed: [] }
    }

    if (task.isAllDay || (!task.scheduledStart && !task.scheduledEnd)) {
      days[dateKey].allDay.push(task)
    } else {
      days[dateKey].timed.push(task)
    }
  }

  return { days }
}

/**
 * Chronological timeline mixing tasks and free-time gaps. Timed tasks are
 * sorted by `scheduledStart`; gaps are inserted between consecutive timed
 * tasks. All-day / un-timed tasks are emitted first as task events without
 * gap calculation (they don't define a clock window to gap against).
 */
export async function getTimelineView(
  userId: string,
  start: string,
  end: string,
): Promise<{
  events: Array<{
    type: 'task' | 'gap'
    task?: TaskModel
    startTime?: string
    endTime?: string
    durationMinutes?: number
  }>
}> {
  const startDate = new Date(`${start}T00:00:00.000Z`)
  const endDate = new Date(`${end}T23:59:59.999Z`)

  const tasks = await tasksRepository.findByDateRange(userId, startDate, endDate)

  const timedTasks = tasks
    .filter((t) => t.scheduledStart && t.scheduledEnd && !t.isAllDay)
    .sort(
      (a, b) =>
        new Date(a.scheduledStart!).getTime() - new Date(b.scheduledStart!).getTime(),
    )

  const events: Array<{
    type: 'task' | 'gap'
    task?: TaskModel
    startTime?: string
    endTime?: string
    durationMinutes?: number
  }> = []

  // All-day / un-timed tasks first — no gap context for these.
  const untimedTasks = tasks.filter(
    (t) => t.isAllDay || !t.scheduledStart || !t.scheduledEnd,
  )
  for (const task of untimedTasks) {
    events.push({ type: 'task', task })
  }

  let previousEnd: Date | null = null

  for (const task of timedTasks) {
    const taskStart = new Date(task.scheduledStart!)
    const taskEnd = new Date(task.scheduledEnd!)

    if (previousEnd && taskStart.getTime() > previousEnd.getTime()) {
      const gapMinutes = Math.round(
        (taskStart.getTime() - previousEnd.getTime()) / 60000,
      )
      if (gapMinutes > 0) {
        events.push({
          type: 'gap',
          startTime: previousEnd.toISOString(),
          endTime: taskStart.toISOString(),
          durationMinutes: gapMinutes,
        })
      }
    }

    const durationMinutes = Math.round(
      (taskEnd.getTime() - taskStart.getTime()) / 60000,
    )

    events.push({
      type: 'task',
      task,
      startTime: taskStart.toISOString(),
      endTime: taskEnd.toISOString(),
      durationMinutes,
    })

    // Track the latest end time seen so far (handles overlapping tasks).
    if (!previousEnd || taskEnd.getTime() > previousEnd.getTime()) {
      previousEnd = taskEnd
    }
  }

  return { events }
}
