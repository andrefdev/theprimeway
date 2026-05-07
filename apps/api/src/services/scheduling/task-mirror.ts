/**
 * Task mirror reconciliation. WorkingSession is the source of truth for
 * "when a task runs"; Task.scheduledStart/End is a denormalized mirror of the
 * (min start, max end) of the task's sessions. Task.scheduledDate is the
 * calendar-date intent — UTC-midnight of the user's local Y-M-D for the first
 * session. Storing it as UTC-midnight (instead of the raw session instant)
 * keeps the today/week filters consistent with date-only inputs from the form.
 *
 * Kept in its own module so callers like `auto-schedule.ts` can use it
 * without importing the facade (which would create a cycle).
 */
import { prisma } from '../../lib/prisma'
import { localYmd } from '@repo/shared/utils'

async function getUserTz(userId: string): Promise<string> {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { timezone: true },
  })
  return settings?.timezone ?? 'UTC'
}

export async function syncTaskMirror(taskId: string): Promise<void> {
  if (!taskId) return
  const sessions = await prisma.workingSession.findMany({
    where: { taskId },
    select: { start: true, end: true, userId: true },
    orderBy: { start: 'asc' },
  })
  if (sessions.length === 0) {
    await prisma.task
      .update({
        where: { id: taskId },
        data: { scheduledStart: null, scheduledEnd: null },
      })
      .catch(() => undefined)
    return
  }
  const first = sessions[0]!
  const last = sessions[sessions.length - 1]!
  const tz = await getUserTz(first.userId)
  const ymd = localYmd(first.start, tz)
  const scheduledDate = new Date(`${ymd}T00:00:00.000Z`)
  await prisma.task
    .update({
      where: { id: taskId },
      data: {
        scheduledStart: first.start,
        scheduledEnd: last.end,
        scheduledDate,
      },
    })
    .catch(() => undefined)
}
