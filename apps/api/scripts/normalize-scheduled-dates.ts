import 'dotenv/config'
import { prisma } from '../src/lib/prisma'
import { localYmd } from '@repo/shared/utils'

/**
 * One-shot reconciliation: rewrite Task.scheduledDate to UTC-midnight of the
 * user's local Y-M-D for any row that's currently stored as a non-midnight
 * timestamp (legacy syncTaskMirror writes were storing the raw session start).
 *
 * Rows already at UTC-midnight are left alone — those came from the date-only
 * input path (normalizeScheduledDate) and the YYYY-MM-DD they encode is
 * already the user's local intent.
 *
 * Idempotent.
 */
async function main() {
  const tasks = await prisma.task.findMany({
    where: { scheduledDate: { not: null } },
    select: { id: true, userId: true, scheduledDate: true },
  })

  const tzCache = new Map<string, string>()
  async function getTz(userId: string): Promise<string> {
    const cached = tzCache.get(userId)
    if (cached) return cached
    const settings = await prisma.userSettings.findUnique({
      where: { userId },
      select: { timezone: true },
    })
    const tz = settings?.timezone ?? 'UTC'
    tzCache.set(userId, tz)
    return tz
  }

  let migrated = 0
  let skipped = 0
  for (const t of tasks) {
    const sd = t.scheduledDate!
    const isUtcMidnight =
      sd.getUTCHours() === 0 &&
      sd.getUTCMinutes() === 0 &&
      sd.getUTCSeconds() === 0 &&
      sd.getUTCMilliseconds() === 0

    if (isUtcMidnight) {
      skipped++
      continue
    }
    if (!t.userId) {
      skipped++
      continue
    }

    const tz = await getTz(t.userId)
    const ymd = localYmd(sd, tz)
    const next = new Date(`${ymd}T00:00:00.000Z`)
    if (next.getTime() === sd.getTime()) {
      skipped++
      continue
    }

    await prisma.task.update({
      where: { id: t.id },
      data: { scheduledDate: next },
    })
    migrated++
  }

  console.log(`Normalized ${migrated} task(s); ${skipped} already at UTC-midnight or skipped.`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
