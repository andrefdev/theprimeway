import 'dotenv/config'
import { prisma } from '../src/lib/prisma'
import { syncTaskMirror } from '../src/services/scheduling/task-mirror'

/**
 * One-shot reconciliation. After this runs, Task.scheduled* is consistent with
 * each task's WorkingSessions (the source of truth):
 *   - Tasks with sessions  → scheduledStart/End/Date recomputed from min/max.
 *   - Tasks without sessions but with stale scheduledStart/End → cleared
 *     (scheduledDate is preserved as the bucket date).
 * Idempotent.
 */
async function main() {
  const withSessions = await prisma.task.findMany({
    where: { sessions: { some: {} } },
    select: { id: true },
  })
  for (const t of withSessions) {
    await syncTaskMirror(t.id)
  }

  const cleared = await prisma.task.updateMany({
    where: { sessions: { none: {} }, scheduledStart: { not: null } },
    data: { scheduledStart: null, scheduledEnd: null },
  })

  console.log(
    `Reconciled ${withSessions.length} tasks with sessions; cleared mirror for ${cleared.count} orphaned tasks.`,
  )
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
