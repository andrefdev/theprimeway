/**
 * Task mirror reconciliation. WorkingSession is the source of truth for
 * "when a task runs"; Task.scheduledStart/End/Date is a denormalized mirror
 * derived from the (min start, max end) of the task's sessions.
 *
 * Kept in its own module so callers like `auto-schedule.ts` can use it
 * without importing the facade (which would create a cycle).
 */
import { prisma } from '../../lib/prisma'

export async function syncTaskMirror(taskId: string): Promise<void> {
  if (!taskId) return
  const sessions = await prisma.workingSession.findMany({
    where: { taskId },
    select: { start: true, end: true },
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
  await prisma.task
    .update({
      where: { id: taskId },
      data: {
        scheduledStart: first.start,
        scheduledEnd: last.end,
        scheduledDate: first.start,
      },
    })
    .catch(() => undefined)
}
