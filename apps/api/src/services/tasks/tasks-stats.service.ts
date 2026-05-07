/**
 * Read-only stats over a user's tasks: completion-impact (the "you just
 * finished a task — here's what that earned you" panel) and aggregate
 * statistics over the last N days.
 *
 * Pure aggregation against `tasksRepository` + a couple of joined Prisma
 * queries for goal progress and today's productivity context. No
 * mutation.
 */
import { tasksRepository } from '../../repositories/tasks.repo'
import { prisma } from '../../lib/prisma'
import { startOfLocalDayUtc } from '@repo/shared/utils'

/**
 * Snapshot served to the UI right after the user marks a task complete.
 * Returns null when the task isn't found or isn't actually completed —
 * the caller can decide how to handle that (we don't 4xx because the
 * client may have raced the cache).
 */
export async function getCompletionImpact(userId: string, taskId: string) {
  const task = await tasksRepository.findById(userId, taskId)
  if (!task || task.status !== 'completed') {
    return null
  }

  // Goal progress, when the task is linked to a weekly goal.
  let goalProgress: { title: string; progress: number; tasksRemaining: number } | null = null
  if ((task as any).weeklyGoalId) {
    const goal = await prisma.goal.findUnique({
      where: { id: (task as any).weeklyGoalId },
      include: { taskLinks: { include: { task: true } } },
    })
    if (goal) {
      const linkedTasks = goal.taskLinks.map((l: any) => l.task)
      const allTasks = linkedTasks.length
      const completedTasks = linkedTasks.filter((t: any) => t.status === 'completed').length
      const openTasks = linkedTasks.filter((t: any) => t.status === 'open').length
      goalProgress = {
        title: goal.title,
        progress: allTasks > 0 ? Math.round((completedTasks / allTasks) * 100) : 0,
        tasksRemaining: openTasks,
      }
    }
  }

  // Today's productivity stats — anchored on the user's local day.
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { timezone: true },
  })
  const tz = settings?.timezone ?? 'UTC'
  const todayStart = startOfLocalDayUtc(new Date(), tz)
  const [tasksCompletedToday, habitsCompletedToday, xpToday] = await Promise.all([
    prisma.task.count({
      where: { userId, status: 'completed', completedAt: { gte: todayStart } },
    }),
    prisma.habitLog.count({
      where: { userId, date: { gte: todayStart }, completedCount: { gt: 0 } },
    }),
    prisma.xpEvent.aggregate({
      where: { userId, earnedDate: new Date().toISOString().split('T')[0]! },
      _sum: { amount: true },
    }),
  ])

  // Time-tracking accuracy.
  const timeStats = task.actualDurationMinutes
    ? {
        actual: task.actualDurationMinutes,
        estimated: task.estimatedDurationMinutes || null,
        accuracy: task.estimatedDurationMinutes
          ? Math.round((task.actualDurationMinutes / task.estimatedDurationMinutes) * 100)
          : null,
      }
    : null

  return {
    task: { id: task.id, title: task.title, priority: task.priority },
    goalProgress,
    todayStats: {
      tasksCompleted: tasksCompletedToday,
      habitsCompleted: habitsCompletedToday,
      xpEarned: xpToday._sum.amount || 0,
    },
    timeStats,
    xpAwarded: (task as any).weeklyGoalId ? 40 : 15,
  }
}

/**
 * Aggregate task statistics for the last `days` days.
 * Includes daily completion counts, average per day, distribution by
 * priority, and an "estimate adherence" score (mean ratio of actual to
 * estimated duration, capped at 2.0 so a single 10x outlier doesn't
 * pin the average to nonsense).
 */
export async function getStatistics(userId: string, days: number = 30) {
  const [completionData, counts] = await Promise.all([
    tasksRepository.getCompletionStats(userId, days),
    tasksRepository.getTaskCounts(userId),
  ])

  // Completed per day.
  const dailyMap = new Map<string, number>()
  for (const task of completionData) {
    if (!task.completedAt) continue
    const day = task.completedAt.toISOString().split('T')[0]!
    dailyMap.set(day, (dailyMap.get(day) || 0) + 1)
  }
  const completedPerDay = Array.from(dailyMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const avgPerDay = completionData.length / Math.max(days, 1)

  // By priority.
  const byPriority: Record<string, number> = {}
  for (const task of completionData) {
    const p = task.priority || 'medium'
    byPriority[p] = (byPriority[p] || 0) + 1
  }

  // Estimate adherence — mean of actual/estimated, capped per-task at 2.
  const withEstimates = completionData.filter(
    (t) => t.estimatedDurationMinutes && t.actualDurationMinutes,
  )
  const adherence =
    withEstimates.length > 0
      ? withEstimates.reduce((sum, t) => {
          const ratio = Math.min(t.actualDurationMinutes! / t.estimatedDurationMinutes!, 2)
          return sum + ratio
        }, 0) / withEstimates.length
      : null

  return {
    period: { days, completedTotal: completionData.length },
    counts,
    avgCompletedPerDay: Math.round(avgPerDay * 100) / 100,
    completedPerDay,
    byPriority,
    estimateAdherence: adherence ? Math.round(adherence * 100) / 100 : null,
  }
}
