/**
 * Deconflict — when a session is moved/created, push conflicting sessions
 * (same user, same day) to new slots after the anchor.
 *
 * Spec: docs/TASK_SCHEDULER_ALGO.md §6.
 */
import { prisma } from '../../lib/prisma'
import { commandManager, CommandChange } from './CommandManager'
import { autoSchedule } from './auto-schedule'
import { dt } from './gap-finder'
import { removeSessionFromCalendar } from '../calendar/session-push.service'

export interface DeconflictResult {
  commandId: string
  movedCount: number
  orphanedCount: number
}

/**
 * Reconcile all sessions that overlap the anchor (excluded from the conflict set).
 * Strategy: delete them, call autoSchedule within same day with earliestStart = anchor.end.
 * If a displaced session fails to reschedule, it stays deleted (task becomes unscheduled).
 */
export async function deconflict(anchorSessionId: string): Promise<DeconflictResult> {
  const anchor = await prisma.workingSession.findUnique({ where: { id: anchorSessionId } })
  if (!anchor) throw new Error('Anchor session not found')

  const settings = await prisma.userSettings.findUnique({ where: { userId: anchor.userId } })
  if (settings && !settings.autoRescheduleOnConflict) {
    const cmd = await commandManager.record({
      userId: anchor.userId,
      type: 'AUTO_RESCHEDULE_DECONFLICT_NOOP',
      changes: [],
      triggeredBy: 'AUTO_RESCHEDULER',
    })
    return { commandId: cmd.id, movedCount: 0, orphanedCount: 0 }
  }

  const tz = settings?.timezone ?? 'UTC'
  const day = dt.startOfDay(anchor.start, tz)
  const dayEnd = dt.endOfDay(anchor.start, tz)

  const conflicting = await prisma.workingSession.findMany({
    where: {
      userId: anchor.userId,
      id: { not: anchor.id },
      start: { lt: anchor.end, gte: day, lte: dayEnd },
      end: { gt: anchor.start },
    },
    orderBy: { start: 'asc' },
  })

  if (conflicting.length === 0) {
    const cmd = await commandManager.record({
      userId: anchor.userId,
      type: 'AUTO_RESCHEDULE_DECONFLICT_NOOP',
      changes: [],
      triggeredBy: 'AUTO_RESCHEDULER',
    })
    return { commandId: cmd.id, movedCount: 0, orphanedCount: 0 }
  }

  const parentCmd = await commandManager.record({
    userId: anchor.userId,
    type: 'AUTO_RESCHEDULE_DECONFLICT',
    changes: [],
    triggeredBy: 'AUTO_RESCHEDULER',
  })

  const changes: CommandChange[] = []
  let moved = 0
  let orphaned = 0

  for (const s of conflicting) {
    const before = { id: s.id, userId: s.userId, taskId: s.taskId, start: s.start, end: s.end, kind: s.kind, createdBy: s.createdBy }
    // Remove from Google Calendar before local delete (fire-and-forget; failure non-fatal)
    removeSessionFromCalendar(s.id).catch((err) =>
      console.error('[DECONFLICT] remove from calendar failed', err),
    )
    await prisma.workingSession.delete({ where: { id: s.id } })
    changes.push({ entity: 'WorkingSession', id: s.id, before, after: null })

    if (!s.taskId) {
      orphaned++
      continue
    }

    const reschedule = await autoSchedule(s.taskId, day, {
      earliestStart: anchor.end,
      parentCommandId: parentCmd.id,
      triggeredBy: 'AUTO_RESCHEDULER',
    })
    if (reschedule.type === 'Success') moved++
    else orphaned++
  }

  // Update parent command payload with the delete changes
  await prisma.command.update({
    where: { id: parentCmd.id },
    data: { payload: { changes } as any },
  })

  return { commandId: parentCmd.id, movedCount: moved, orphanedCount: orphaned }
}
