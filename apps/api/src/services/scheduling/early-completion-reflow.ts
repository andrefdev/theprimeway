/**
 * Early-completion reflow — when a task completes before its session's scheduled end,
 * truncate the session and shift the contiguous group of sessions earlier to reclaim time.
 *
 * Spec: docs/TASK_SCHEDULER_ALGO.md §7.
 */
import { prisma } from '../../lib/prisma'
import { commandManager, CommandChange } from './CommandManager'
import { findCalendarEventOverlapping, dt } from './gap-finder'
import { updateSessionOnCalendar } from '../calendar/session-push.service'

export interface EarlyReflowResult {
  commandId: string
  truncated: boolean
  shifted: number
  skipped: number
}

/**
 * Call when task completes. `completedAt` defaults to now.
 * Finds the active/most-recent session of the task today; if `completedAt < session.end`,
 * truncates and shifts contiguous later sessions earlier by the freed delta.
 * Respects CalendarEvents: if a shifted slot would overlap an event, that session is skipped.
 */
export async function onTaskCompletedEarly(taskId: string, completedAt: Date = new Date()): Promise<EarlyReflowResult | null> {
  const task = await prisma.task.findUnique({ where: { id: taskId } })
  if (!task || !task.userId) return null
  const userId = task.userId

  const settings = await prisma.userSettings.findUnique({ where: { userId } })
  if (settings && !settings.autoRescheduleOnEarlyCompletion) return null

  const tz = settings?.timezone ?? 'UTC'
  const day = dt.startOfDay(completedAt, tz)
  const dayEnd = dt.endOfDay(completedAt, tz)

  // Active session: starts <= completedAt < end, for this task, today
  const active = await prisma.workingSession.findFirst({
    where: { taskId, userId, start: { lte: completedAt, gte: day }, end: { gt: completedAt, lte: dayEnd } },
    orderBy: { start: 'desc' },
  })
  if (!active) return null

  const freed = dt.diffMinutes(completedAt, active.end)
  if (freed < 1) return null

  const parentCmd = await commandManager.record({
    userId,
    type: 'AUTO_RESCHEDULE_EARLY_COMPLETION',
    changes: [],
    triggeredBy: 'AUTO_RESCHEDULER',
  })

  const changes: CommandChange[] = []

  // 1) Truncate the active session
  const beforeActive = { id: active.id, start: active.start, end: active.end }
  const updatedActive = await prisma.workingSession.update({ where: { id: active.id }, data: { end: completedAt } })
  changes.push({
    entity: 'WorkingSession',
    id: active.id,
    before: beforeActive,
    after: { id: updatedActive.id, start: updatedActive.start, end: updatedActive.end },
  })
  updateSessionOnCalendar(active.id).catch((err) =>
    console.error('[EARLY_COMPLETION] update calendar failed', err),
  )

  // 2) Find contiguous group after `completedAt`
  const contiguity = settings?.contiguityThresholdMinutes ?? 10

  const later = await prisma.workingSession.findMany({
    where: { userId, id: { not: active.id }, start: { gte: updatedActive.end }, end: { lte: dayEnd } },
    orderBy: { start: 'asc' },
  })

  const group: typeof later = []
  let cursor = updatedActive.end
  for (const s of later) {
    const gap = dt.diffMinutes(cursor, s.start)
    if (gap <= contiguity) {
      group.push(s)
      cursor = s.end
    } else {
      break
    }
  }

  // 3) Shift group earlier by `freed` minutes, respecting calendar events
  let shifted = 0
  let skipped = 0
  let proposedStart = group[0] ? dt.subMinutes(group[0].start, freed) : null

  for (const s of group) {
    if (!proposedStart) break
    const duration = dt.diffMinutes(s.start, s.end)
    const proposedEnd = dt.addMinutes(proposedStart, duration)

    const conflict = await findCalendarEventOverlapping(userId, proposedStart, proposedEnd)
    if (conflict) {
      proposedStart = s.end
      skipped++
      continue
    }

    const before = { id: s.id, start: s.start, end: s.end }
    const updated = await prisma.workingSession.update({ where: { id: s.id }, data: { start: proposedStart, end: proposedEnd } })
    changes.push({ entity: 'WorkingSession', id: s.id, before, after: { id: updated.id, start: updated.start, end: updated.end } })
    updateSessionOnCalendar(s.id).catch((err) =>
      console.error('[EARLY_COMPLETION] update calendar failed', err),
    )
    shifted++
    proposedStart = proposedEnd
  }

  await prisma.command.update({ where: { id: parentCmd.id }, data: { payload: { changes } as any } })

  return { commandId: parentCmd.id, truncated: true, shifted, skipped }
}
