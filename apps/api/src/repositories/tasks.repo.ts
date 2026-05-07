/**
 * Tasks Repository — Pure data access layer
 *
 * Responsibilities:
 * - Direct Prisma queries (findMany, create, update, delete)
 * - Returns Prisma objects directly (camelCase)
 * - Date normalization
 * - NO business logic, NO HTTP concerns
 *
 * Legacy `weeklyGoalId` is derived from TaskGoal M2M (first WEEK-horizon goal).
 * Writes that set `weeklyGoalId` are translated to TaskGoal upsert/delete.
 */
import { prisma } from '../lib/prisma'
import { endOfLocalDayUtc, startOfLocalDayUtc, ymdToLocalDayUtc } from '@repo/shared/utils'

async function getUserTz(userId: string): Promise<string> {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { timezone: true },
  })
  return settings?.timezone ?? 'UTC'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface FindTasksOptions {
  status?: string
  priority?: string
  scheduledDate?: { gte?: Date; lte?: Date }
  archivedAt?: null | { not: null }
  weeklyGoalId?: string
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Normalize a date string to midnight UTC to prevent timezone day-boundary shifts */
export function normalizeScheduledDate(dateStr: string): Date {
  const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr
  return new Date(`${datePart}T00:00:00.000Z`)
}

const defaultInclude = {
  goalLinks: { include: { goal: true } },
} as const

const defaultOrderBy = [
  { scheduledStart: 'asc' as const },
  { orderInDay: 'asc' as const },
  { createdAt: 'desc' as const },
]

/** Attach legacy `weeklyGoalId` / `weeklyGoal` derived from TaskGoal M2M. */
function attachLegacyWeekly<T extends { goalLinks?: any[] } | null>(task: T): any {
  if (!task) return task
  const links = (task as any).goalLinks ?? []
  const weekly = links.find((l: any) => l.goal?.horizon === 'WEEK')
  const weeklyGoal = weekly
    ? {
        id: weekly.goal.id,
        userId: weekly.goal.userId,
        title: weekly.goal.title,
        weekStartDate: weekly.goal.startsOn,
        status: 'planned',
      }
    : null
  // Map DB column `estimatedDurationMinutes` → public `estimatedDuration` for client.
  const estimatedDuration = (task as any).estimatedDurationMinutes ?? null
  return { ...task, weeklyGoalId: weekly?.goalId ?? null, weeklyGoal, estimatedDuration }
}

function attachLegacyWeeklyMany<T extends { goalLinks?: any[] }>(tasks: T[]): any[] {
  return tasks.map((t) => attachLegacyWeekly(t))
}

/** Upsert/delete the single WEEK-horizon link for a task to emulate legacy weeklyGoalId semantics. */
async function syncWeeklyLink(taskId: string, weeklyGoalId: string | null) {
  const existing = await prisma.taskGoal.findMany({
    where: { taskId, goal: { horizon: 'WEEK' } },
    select: { goalId: true },
  })
  const existingIds = existing.map((e: { goalId: string }) => e.goalId)

  if (weeklyGoalId) {
    // Remove any other WEEK links
    const toRemove = existingIds.filter((id: string) => id !== weeklyGoalId)
    if (toRemove.length > 0) {
      await prisma.taskGoal.deleteMany({ where: { taskId, goalId: { in: toRemove } } })
    }
    if (!existingIds.includes(weeklyGoalId)) {
      await prisma.taskGoal.create({ data: { taskId, goalId: weeklyGoalId } })
    }
  } else if (existingIds.length > 0) {
    await prisma.taskGoal.deleteMany({ where: { taskId, goalId: { in: existingIds } } })
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------
class TasksRepository {
  async findMany(userId: string, options: FindTasksOptions = {}) {
    const where: any = { userId }
    if (options.status) where.status = options.status
    if (options.priority) where.priority = options.priority
    if (options.scheduledDate) where.scheduledDate = options.scheduledDate
    if (options.archivedAt !== undefined) where.archivedAt = options.archivedAt
    if (options.weeklyGoalId) where.goalLinks = { some: { goalId: options.weeklyGoalId } }

    const tasks = await prisma.task.findMany({
      where,
      include: defaultInclude,
      orderBy: defaultOrderBy,
      take: options.limit ?? 200,
      skip: options.offset ?? 0,
    })
    return attachLegacyWeeklyMany(tasks)
  }

  async findTodaysTasks(userId: string, todayISO: string) {
    const tz = await getUserTz(userId)
    const anchor = ymdToLocalDayUtc(todayISO, tz)
    const dayStart = startOfLocalDayUtc(anchor, tz)
    const dayEnd = endOfLocalDayUtc(anchor, tz)
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        scheduledDate: { gte: dayStart, lte: dayEnd },
        status: 'open',
        archivedAt: null,
      },
      include: defaultInclude,
      orderBy: defaultOrderBy,
    })
    return attachLegacyWeeklyMany(tasks)
  }

  async findBacklogTasks(userId: string) {
    const tasks = await prisma.task.findMany({
      where: { userId, scheduledDate: null, status: 'open', archivedAt: null },
      include: defaultInclude,
      orderBy: [{ createdAt: 'desc' }],
    })
    return attachLegacyWeeklyMany(tasks)
  }

  async findArchivedTasks(userId: string) {
    // Only rolled-over open tasks belong in the archive panel; completed
    // tasks may have archivedAt set by the autoArchiveCompleted cron, but
    // they're hidden from this view (the user can't act on them anyway).
    const tasks = await prisma.task.findMany({
      where: { userId, archivedAt: { not: null }, status: 'open' },
      include: defaultInclude,
      orderBy: [{ archivedAt: 'desc' }],
    })
    return attachLegacyWeeklyMany(tasks)
  }

  async findWeekTasks(userId: string, weekStartISO: string, weekEndISO: string) {
    const tz = await getUserTz(userId)
    const start = startOfLocalDayUtc(ymdToLocalDayUtc(weekStartISO, tz), tz)
    const end = endOfLocalDayUtc(ymdToLocalDayUtc(weekEndISO, tz), tz)
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        archivedAt: null,
        OR: [
          { scheduledDate: { gte: start, lte: end } },
          { scheduledDate: null, status: 'open' },
        ],
      },
      include: defaultInclude,
      orderBy: defaultOrderBy,
    })
    return attachLegacyWeeklyMany(tasks)
  }

  async findById(userId: string, taskId: string) {
    const task = await prisma.task.findFirst({
      where: { id: taskId, userId },
      include: defaultInclude,
    })
    return attachLegacyWeekly(task)
  }

  async create(userId: string, data: Record<string, any>) {
    const task = await prisma.task.create({
      data: {
        userId,
        title: data.title,
        description: data.description,
        status: data.status || 'open',
        priority: data.priority || 'medium',
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        scheduledDate: data.scheduledDate ? normalizeScheduledDate(data.scheduledDate) : undefined,
        scheduledStart: data.scheduledStart ? new Date(data.scheduledStart) : undefined,
        scheduledEnd: data.scheduledEnd ? new Date(data.scheduledEnd) : undefined,
        isAllDay: data.isAllDay,
        estimatedDurationMinutes: data.estimatedDurationMinutes,
        acceptanceCriteria: data.acceptanceCriteria,
        backlogState: data.backlogState,
        source: data.source,
        tags: data.tags || [],
        isRecurring: data.isRecurring,
        recurrenceRule: data.recurrenceRule,
        recurringParentId: data.recurringParentId,
        recurrenceEndDate: data.recurrenceEndDate ? new Date(data.recurrenceEndDate) : undefined,
        scheduledBucket: data.scheduledBucket ?? undefined,
        channelId: data.channelId ?? undefined,
      },
    })
    if (data.weeklyGoalId) await syncWeeklyLink(task.id, data.weeklyGoalId)
    const hydrated = await prisma.task.findUnique({ where: { id: task.id }, include: defaultInclude })
    return attachLegacyWeekly(hydrated)
  }

  async update(userId: string, taskId: string, data: Record<string, any>) {
    const existing = await prisma.task.findFirst({ where: { id: taskId, userId } })
    if (!existing) return null

    const updateData: any = {}
    if (data.title !== undefined) updateData.title = data.title
    if (data.description !== undefined) updateData.description = data.description
    if (data.status !== undefined) updateData.status = data.status
    if (data.priority !== undefined) updateData.priority = data.priority
    if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null
    if (data.scheduledDate !== undefined) updateData.scheduledDate = data.scheduledDate ? normalizeScheduledDate(data.scheduledDate) : null
    if (data.scheduledStart !== undefined) updateData.scheduledStart = data.scheduledStart ? new Date(data.scheduledStart) : null
    if (data.scheduledEnd !== undefined) updateData.scheduledEnd = data.scheduledEnd ? new Date(data.scheduledEnd) : null
    if (data.isAllDay !== undefined) updateData.isAllDay = data.isAllDay
    if (data.estimatedDurationMinutes !== undefined) updateData.estimatedDurationMinutes = data.estimatedDurationMinutes
    if (data.acceptanceCriteria !== undefined) updateData.acceptanceCriteria = data.acceptanceCriteria
    if (data.backlogState !== undefined) updateData.backlogState = data.backlogState
    if (data.tags !== undefined) updateData.tags = data.tags
    if (data.archivedAt !== undefined) updateData.archivedAt = data.archivedAt ? new Date(data.archivedAt) : null
    if (data.orderInDay !== undefined) updateData.orderInDay = data.orderInDay
    if (data.isRecurring !== undefined) updateData.isRecurring = data.isRecurring
    if (data.recurrenceRule !== undefined) updateData.recurrenceRule = data.recurrenceRule
    if (data.recurringParentId !== undefined) updateData.recurringParentId = data.recurringParentId
    if (data.recurrenceEndDate !== undefined) updateData.recurrenceEndDate = data.recurrenceEndDate ? new Date(data.recurrenceEndDate) : null
    if (data.actualStart !== undefined) updateData.actualStart = data.actualStart ? new Date(data.actualStart) : null
    if (data.actualEnd !== undefined) updateData.actualEnd = data.actualEnd ? new Date(data.actualEnd) : null
    if (data.actualDurationMinutes !== undefined) updateData.actualDurationMinutes = data.actualDurationMinutes
    if (data.actualDurationSeconds !== undefined) updateData.actualDurationSeconds = data.actualDurationSeconds
    if (data.scheduledBucket !== undefined) updateData.scheduledBucket = data.scheduledBucket
    if (data.channelId !== undefined) updateData.channelId = data.channelId

    // Auto-set completedAt
    if (data.status === 'completed' && !existing.completedAt) {
      updateData.completedAt = new Date()
    } else if (data.status === 'open') {
      updateData.completedAt = null
    }

    await prisma.task.update({ where: { id: taskId }, data: updateData })
    if (data.weeklyGoalId !== undefined) {
      await syncWeeklyLink(taskId, (data.weeklyGoalId as string | null) || null)
    }
    const hydrated = await prisma.task.findUnique({ where: { id: taskId }, include: defaultInclude })
    return attachLegacyWeekly(hydrated)
  }

  async delete(userId: string, taskId: string): Promise<boolean> {
    const existing = await prisma.task.findFirst({ where: { id: taskId, userId } })
    if (!existing) return false
    await prisma.task.delete({ where: { id: taskId } })
    return true
  }

  async archivePastTasks(userId: string, referenceDate: string, daysThreshold: number = 1): Promise<number> {
    const cutoff = new Date(`${referenceDate}T00:00:00.000Z`)
    const offset = Math.max(0, daysThreshold - 1)
    if (offset > 0) cutoff.setUTCDate(cutoff.getUTCDate() - offset)
    const result = await prisma.task.updateMany({
      where: {
        userId,
        status: 'open',
        archivedAt: null,
        scheduledDate: { lt: cutoff },
      },
      data: { archivedAt: new Date() },
    })
    return result.count
  }

  async autoArchiveCompleted(userId: string, daysOld: number): Promise<number> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - daysOld)
    const result = await prisma.task.updateMany({
      where: {
        userId,
        status: 'completed',
        archivedAt: null,
        completedAt: { lt: cutoff },
      },
      data: { archivedAt: new Date() },
    })
    return result.count
  }

  async count(userId: string, where?: Record<string, any>): Promise<number> {
    return prisma.task.count({ where: { userId, ...where } })
  }

  async getCompletionStats(userId: string, days: number) {
    const since = new Date()
    since.setDate(since.getDate() - days)

    const completed = await prisma.task.findMany({
      where: {
        userId,
        status: 'completed',
        completedAt: { gte: since },
      },
      select: {
        completedAt: true,
        priority: true,
        estimatedDurationMinutes: true,
        actualDurationMinutes: true,
      },
    })
    return completed
  }

  async findRecurringTasks(userId: string) {
    const tz = await getUserTz(userId)
    const today = startOfLocalDayUtc(new Date(), tz)
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        isRecurring: true,
        archivedAt: null,
        OR: [
          { recurrenceEndDate: null },
          { recurrenceEndDate: { gte: today } },
        ],
      },
      include: defaultInclude,
    })
    return attachLegacyWeeklyMany(tasks)
  }

  async findInstancesForDate(userId: string, parentId: string, date: Date) {
    const tz = await getUserTz(userId)
    const dayStart = startOfLocalDayUtc(date, tz)
    const dayEnd = endOfLocalDayUtc(date, tz)
    return prisma.task.findMany({
      where: {
        userId,
        recurringParentId: parentId,
        scheduledDate: { gte: dayStart, lte: dayEnd },
      },
    })
  }

  async findCompletedWithDuration(userId: string, limit: number = 20) {
    return prisma.task.findMany({
      where: {
        userId,
        status: 'completed',
        actualDurationMinutes: { gt: 0 },
      },
      select: {
        title: true,
        description: true,
        priority: true,
        tags: true,
        estimatedDurationMinutes: true,
        actualDurationMinutes: true,
      },
      orderBy: { completedAt: 'desc' },
      take: limit,
    })
  }

  async findByDateRange(userId: string, start: Date, end: Date) {
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        archivedAt: null,
        OR: [
          { scheduledDate: { gte: start, lte: end } },
          { dueDate: { gte: start, lte: end } },
        ],
      },
      include: defaultInclude,
      orderBy: defaultOrderBy,
    })
    return attachLegacyWeeklyMany(tasks)
  }

  async findCompletedWithActualStart(userId: string, limit: number = 50) {
    return prisma.task.findMany({
      where: {
        userId,
        status: 'completed',
        actualStart: { not: null },
      },
      select: {
        title: true,
        priority: true,
        tags: true,
        estimatedDurationMinutes: true,
        actualDurationMinutes: true,
        actualStart: true,
        completedAt: true,
      },
      orderBy: { completedAt: 'desc' },
      take: limit,
    })
  }

  async findOpenTasks(userId: string, limit: number) {
    return prisma.task.findMany({
      where: { userId, status: 'open' },
      take: limit,
      orderBy: { createdAt: 'desc' },
    })
  }

  async getTaskCounts(userId: string) {
    const [total, open, completed, archived] = await Promise.all([
      prisma.task.count({ where: { userId } }),
      prisma.task.count({ where: { userId, status: 'open', archivedAt: null } }),
      prisma.task.count({ where: { userId, status: 'completed' } }),
      prisma.task.count({ where: { userId, archivedAt: { not: null } } }),
    ])
    return { total, open, completed, archived }
  }
}

export const tasksRepository = new TasksRepository()
