/**
 * Late-timer detector — when the user starts the timer well after the scheduled session start,
 * offer (PROMPT) or perform (AUTO) moving the session to "now".
 *
 * Spec: docs/TASK_SCHEDULER_ALGO.md §8.
 */
import { prisma } from '../../lib/prisma'
import { commandManager, CommandChange } from './CommandManager'
import { deconflict } from './deconflict'
import { dt } from './gap-finder'
import { updateSessionOnCalendar } from '../calendar/session-push.service'

export type LateTimerAction =
  | { action: 'NONE' }
  | { action: 'PROMPT'; sessionId: string; expectedStart: Date; delayMinutes: number }
  | { action: 'AUTO_MOVED'; sessionId: string; commandId: string; delayMinutes: number }
  | { action: 'LIVE_SESSION_OFFERED'; delayMinutes: 0 }

export async function onTimerStart(taskId: string, startedAt: Date = new Date()): Promise<LateTimerAction> {
  const task = await prisma.task.findUnique({ where: { id: taskId } })
  if (!task || !task.userId) return { action: 'NONE' }
  const userId = task.userId

  // Always record the timer event
  await prisma.timerEvent.create({ data: { taskId, type: 'START', timestamp: startedAt } })

  const settings = await prisma.userSettings.findUnique({ where: { userId } })
  if (!settings?.detectLateTimerStart) return { action: 'NONE' }

  const tz = settings.timezone ?? 'UTC'
  const day = dt.startOfDay(startedAt, tz)
  const dayEnd = dt.endOfDay(startedAt, tz)

  // Prefer: session containing `startedAt` > next upcoming > last of day
  const containing = await prisma.workingSession.findFirst({
    where: { taskId, userId, start: { lte: startedAt, gte: day }, end: { gt: startedAt, lte: dayEnd } },
    orderBy: { start: 'desc' },
  })
  const upcoming = containing
    ? null
    : await prisma.workingSession.findFirst({
        where: { taskId, userId, start: { gt: startedAt, lte: dayEnd } },
        orderBy: { start: 'asc' },
      })
  const fallback = containing || upcoming
    ? null
    : await prisma.workingSession.findFirst({
        where: { taskId, userId, start: { gte: day, lte: dayEnd } },
        orderBy: { start: 'desc' },
      })
  const expected = containing ?? upcoming ?? fallback
  if (!expected) return { action: 'LIVE_SESSION_OFFERED', delayMinutes: 0 }

  const delay = dt.diffMinutes(expected.start, startedAt)
  if (delay <= 0) return { action: 'NONE' }
  if (delay < settings.lateTimerThresholdMinutes) return { action: 'NONE' }

  if (settings.lateTimerMode === 'PROMPT') {
    return { action: 'PROMPT', sessionId: expected.id, expectedStart: expected.start, delayMinutes: delay }
  }
  if (settings.lateTimerMode === 'AUTO') {
    const cmd = await moveSessionToNow(expected.id, startedAt, userId)
    return { action: 'AUTO_MOVED', sessionId: expected.id, commandId: cmd.commandId, delayMinutes: delay }
  }
  return { action: 'NONE' }
}

/** Move a session so it starts at `now`, preserving its duration. Triggers deconflict. */
export async function moveSessionToNow(sessionId: string, now: Date, userId: string): Promise<{ commandId: string }> {
  const session = await prisma.workingSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new Error('Session not found')
  const duration = dt.diffMinutes(session.start, session.end)
  const newEnd = dt.addMinutes(now, duration)

  const before = { id: session.id, start: session.start, end: session.end }
  const updated = await prisma.workingSession.update({ where: { id: session.id }, data: { start: now, end: newEnd } })
  updateSessionOnCalendar(session.id).catch((err) =>
    console.error('[LATE_TIMER] update calendar failed', err),
  )

  const parent = await commandManager.record({
    userId,
    type: 'MOVE_SESSION_TO_TIMER_START',
    changes: [
      {
        entity: 'WorkingSession',
        id: session.id,
        before,
        after: { id: updated.id, start: updated.start, end: updated.end },
      } satisfies CommandChange,
    ],
    triggeredBy: 'USER_ACTION',
  })

  // Cascade deconflict as a child command
  const child = await deconflict(sessionId)
  if (child.movedCount + child.orphanedCount > 0) {
    await prisma.command.update({ where: { id: child.commandId }, data: { parentCommandId: parent.id } })
  }

  return { commandId: parent.id }
}
