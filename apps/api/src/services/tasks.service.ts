/**
 * Tasks Service — Business logic layer
 *
 * Responsibilities:
 * - Orchestrate repository calls
 * - Business rules (auto-scheduling, validation, XP awards)
 * - Cross-domain logic (calendar sync, gamification)
 * - NO Prisma queries, NO HTTP concerns
 */
import { tasksRepository } from '../repositories/tasks.repo'
import { calendarService } from './calendar.service'
import { gamificationService } from './gamification.service'
import { gamificationEvents } from './gamification/events'
import { syncService } from './sync.service'
import { webhooksService } from './webhooks.service'
import { schedulingFacade } from './scheduling/scheduling-facade'
import { collectBusyBlocks, computeGaps, getDayWindow, dt } from './scheduling/gap-finder'
import { ymdToLocalDayUtc, startOfLocalDayUtc, localYmd } from '@repo/shared/utils'
import { enforceLimit } from '../lib/limits'
import { FEATURES } from '@repo/shared/constants'
import { prisma } from '../lib/prisma'
import type { Task } from '@prisma/client'
import { generateObject } from 'ai'
import { taskModel, fastModel } from '../lib/ai-models'
import { z } from 'zod'

async function getUserTz(userId: string): Promise<string> {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { timezone: true },
  })
  return settings?.timezone ?? 'UTC'
}

type TaskModel = Task & { weeklyGoal?: unknown }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface CreateTaskInput {
  title: string
  description?: string
  priority?: string
  dueDate?: string
  scheduledDate?: string
  scheduledStart?: string
  scheduledEnd?: string
  isAllDay?: boolean
  estimatedDuration?: number
  acceptanceCriteria?: string | null
  backlogState?: string
  source?: string
  tags?: string[]
  weeklyGoalId?: string
  channelId?: string | null
  scheduledBucket?: string | null
  isRecurring?: boolean
  recurrenceRule?: string
  recurrenceEndDate?: string
  /** Auto-fit into the first free gap on scheduledDate when no times provided. */
  autoSchedule?: boolean
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  status?: string
  priority?: string
  dueDate?: string
  scheduledDate?: string
  scheduledStart?: string
  scheduledEnd?: string
  isAllDay?: boolean
  estimatedDuration?: number
  acceptanceCriteria?: string | null
  backlogState?: string
  tags?: string[]
  weeklyGoalId?: string
  channelId?: string | null
  scheduledBucket?: string | null
  archivedAt?: string | null
  orderInDay?: number
  isRecurring?: boolean
  recurrenceRule?: string
  recurrenceEndDate?: string
  actualStart?: string | null
  actualEnd?: string | null
  actualDurationMinutes?: number
  actualDurationSeconds?: number
}

export interface ListTasksFilters {
  filter?: 'today' | 'backlog' | 'archive' | 'week'
  status?: string
  priority?: string
  referenceDate?: string
  weeklyGoalId?: string
  weekStart?: string
  weekEnd?: string
  limit?: number
  offset?: number
}

export interface GroupedTasksResult {
  groups: Array<{ date_key: string; tasks: TaskModel[] }>
  archive: TaskModel[]
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
class TasksService {
  /** List tasks with various filter strategies */
  async listTasks(userId: string, filters: ListTasksFilters): Promise<{ data: TaskModel[]; count: number }> {
    const ref = filters.referenceDate || new Date().toISOString().split('T')[0]!

    let data: TaskModel[]

    switch (filters.filter) {
      case 'today':
        data = await tasksRepository.findTodaysTasks(userId, ref)
        break
      case 'backlog':
        data = await tasksRepository.findBacklogTasks(userId)
        break
      case 'archive':
        data = await tasksRepository.findArchivedTasks(userId)
        break
      case 'week':
        data = await tasksRepository.findWeekTasks(
          userId,
          filters.weekStart || ref,
          filters.weekEnd || ref,
        )
        break
      default:
        data = await tasksRepository.findMany(userId, {
          status: filters.status,
          priority: filters.priority,
          weeklyGoalId: filters.weeklyGoalId,
          limit: filters.limit,
          offset: filters.offset,
        })
    }

    return { data, count: data.length }
  }

  /** Get grouped tasks for dashboard view */
  async getGroupedTasks(
    userId: string,
    referenceDate: string,
    opts?: {
      startDate?: string
      endDate?: string
      autoArchive?: boolean
      autoArchiveDays?: number
    },
  ): Promise<GroupedTasksResult> {
    // Auto-archive past incomplete tasks (skipped when user disabled the toggle)
    if (opts?.autoArchive !== false) {
      await tasksRepository.archivePastTasks(userId, referenceDate, opts?.autoArchiveDays ?? 1)
    }

    const hasRange = !!(opts?.startDate && opts?.endDate)
    const scheduledDateFilter = hasRange
      ? {
          gte: new Date(`${opts!.startDate}T00:00:00.000Z`),
          lte: new Date(`${opts!.endDate}T23:59:59.999Z`),
        }
      : undefined

    // Fetch all non-archived tasks (open + completed) and archive
    const [activeTasks, archivedTasks] = await Promise.all([
      tasksRepository.findMany(userId, {
        archivedAt: null,
        ...(scheduledDateFilter ? { scheduledDate: scheduledDateFilter } : {}),
      }),
      tasksRepository.findArchivedTasks(userId),
    ])

    // Group by scheduled date
    const groupMap = new Map<string, TaskModel[]>()

    for (const task of activeTasks) {
      const dateKey = task.scheduledDate
        ? task.scheduledDate.toISOString().split('T')[0]!
        : 'no-date'

      if (!groupMap.has(dateKey)) groupMap.set(dateKey, [])
      groupMap.get(dateKey)!.push(task)
    }

    // Sort groups: dates descending (newest first), 'no-date' at end
    const groups = Array.from(groupMap.entries())
      .sort(([a], [b]) => {
        if (a === 'no-date') return 1
        if (b === 'no-date') return -1
        return b.localeCompare(a)
      })
      .map(([date_key, tasks]) => ({ date_key, tasks }))

    return { groups, archive: archivedTasks }
  }

  /** Get a single task */
  async getTask(userId: string, taskId: string): Promise<TaskModel | null> {
    return tasksRepository.findById(userId, taskId)
  }

  /** Create a new task with optional auto-scheduling */
  async createTask(userId: string, input: CreateTaskInput): Promise<TaskModel> {
    console.log('📥 TasksService.createTask - input:', input)
    await enforceLimit(userId, FEATURES.TASKS_LIMIT)

    const data: Record<string, any> = {
      title: input.title,
      description: input.description,
      priority: input.priority || 'medium',
      tags: input.tags || [],
      weeklyGoalId: input.weeklyGoalId,
      channelId: input.channelId,
      scheduledBucket: input.scheduledBucket,
      isAllDay: input.isAllDay,
      estimatedDurationMinutes: input.estimatedDuration,
      acceptanceCriteria: input.acceptanceCriteria,
      backlogState: input.backlogState,
      source: input.source,
      isRecurring: input.isRecurring,
      recurrenceRule: input.recurrenceRule,
      recurrenceEndDate: input.recurrenceEndDate,
    }

    if (input.dueDate) data.dueDate = input.dueDate
    if (input.scheduledDate) data.scheduledDate = input.scheduledDate

    const wantsExplicitTimes =
      !!input.scheduledStart && !!input.scheduledEnd && !input.isAllDay

    if (wantsExplicitTimes) {
      // The session created below will write scheduledStart/End/Date via
      // syncTaskMirror. We pre-fill scheduledDate so the row has a bucket date
      // even before the session insert lands. Pass a Y-M-D string (not a Date)
      // so normalizeScheduledDate stores UTC-midnight of the user's local day.
      const tz = await getUserTz(userId)
      data.scheduledDate = localYmd(new Date(input.scheduledStart!), tz)
    }
    // All-day tasks: keep only the date.

    console.log('📥 TasksService.createTask - data to be saved:', data)
    let task = await tasksRepository.create(userId, data)

    // Explicit-times path: a single WorkingSession owns the schedule. The
    // facade pushes to Google, mirrors back to Task, and publishes session.*.
    if (task && wantsExplicitTimes) {
      try {
        await schedulingFacade.createSession({
          userId,
          taskId: task.id,
          start: new Date(input.scheduledStart!),
          end: new Date(input.scheduledEnd!),
          createdBy: 'USER',
        })
        const refreshed = await tasksRepository.findById(userId, task.id)
        if (refreshed) task = refreshed
      } catch (err) {
        console.error('[CREATE_SESSION_ON_CREATE]', err)
      }
    }

    // Opt-in: auto-fit into the first free gap on scheduledDate when no explicit times.
    if (
      task &&
      input.autoSchedule &&
      input.scheduledDate &&
      !input.scheduledStart &&
      !input.isAllDay
    ) {
      try {
        await schedulingFacade.scheduleTask(task.id, input.scheduledDate.slice(0, 10), { triggeredBy: 'USER_ACTION' })
        const refreshed = await tasksRepository.findById(userId, task.id)
        if (refreshed) task = refreshed
      } catch (err) {
        console.error('[AUTO_SCHEDULE_ON_CREATE]', err)
      }
    }

    if (task) syncService.publish(userId, { type: 'task.created', payload: { id: task.id } })

    return task
  }

  /** Update a task with business rules */
  async updateTask(userId: string, taskId: string, input: UpdateTaskInput): Promise<TaskModel | null> {
    // Validate title if provided
    if (input.title !== undefined && (!input.title.trim() || input.title.length > 255)) {
      throw new Error('Title must be 1-255 characters')
    }

    // Get current task to check if status is changing to 'completed'
    const currentTask = await tasksRepository.findById(userId, taskId)
    if (!currentTask) return null

    // Map camelCase input to repository format
    const data: Record<string, any> = {}

    if (input.title !== undefined) data.title = input.title
    if (input.description !== undefined) data.description = input.description
    if (input.status !== undefined) data.status = input.status
    if (input.priority !== undefined) data.priority = input.priority
    if (input.dueDate !== undefined) data.dueDate = input.dueDate
    if (input.scheduledDate !== undefined) data.scheduledDate = input.scheduledDate
    if (input.scheduledStart !== undefined) data.scheduledStart = input.scheduledStart
    if (input.scheduledEnd !== undefined) data.scheduledEnd = input.scheduledEnd
    if (input.isAllDay !== undefined) data.isAllDay = input.isAllDay
    if (input.estimatedDuration !== undefined) data.estimatedDurationMinutes = input.estimatedDuration
    if (input.acceptanceCriteria !== undefined) data.acceptanceCriteria = input.acceptanceCriteria
    if (input.backlogState !== undefined) data.backlogState = input.backlogState
    if (input.tags !== undefined) data.tags = input.tags
    if (input.weeklyGoalId !== undefined) data.weeklyGoalId = input.weeklyGoalId
    if (input.channelId !== undefined) data.channelId = input.channelId
    if (input.scheduledBucket !== undefined) data.scheduledBucket = input.scheduledBucket
    if (input.archivedAt !== undefined) data.archivedAt = input.archivedAt
    if (input.orderInDay !== undefined) data.orderInDay = input.orderInDay
    if (input.isRecurring !== undefined) data.isRecurring = input.isRecurring
    if (input.recurrenceRule !== undefined) data.recurrenceRule = input.recurrenceRule
    if (input.recurrenceEndDate !== undefined) data.recurrenceEndDate = input.recurrenceEndDate
    if (input.actualStart !== undefined) data.actualStart = input.actualStart
    if (input.actualEnd !== undefined) data.actualEnd = input.actualEnd
    if (input.actualDurationMinutes !== undefined) data.actualDurationMinutes = input.actualDurationMinutes
    if (input.actualDurationSeconds !== undefined) data.actualDurationSeconds = input.actualDurationSeconds

    // Schedule-time changes (scheduledStart/End) are owned by the
    // SchedulingFacade — it moves/creates/removes the WorkingSession and
    // mirrors back to Task. Detect the user's intent up-front, strip those
    // fields from the repo update, and route through the facade after.
    const startProvided = 'scheduledStart' in input
    const newStartTs = startProvided && input.scheduledStart
      ? new Date(input.scheduledStart).getTime()
      : null
    const curStartTs = currentTask.scheduledStart?.getTime() ?? null
    const startActuallyChanged = startProvided && newStartTs !== curStartTs

    let scheduleIntent: 'clear' | 'set' | 'none' = 'none'
    let intentStart: Date | null = null
    let intentEnd: Date | null = null
    if (input.isAllDay) {
      scheduleIntent = 'clear'
    } else if (startActuallyChanged) {
      if (input.scheduledStart && input.scheduledEnd) {
        scheduleIntent = 'set'
        intentStart = new Date(input.scheduledStart)
        intentEnd = new Date(input.scheduledEnd)
      } else if (input.scheduledStart === null) {
        scheduleIntent = 'clear'
      }
    }

    if (scheduleIntent !== 'none') {
      // Facade owns scheduledStart/End; don't let the repo write them directly.
      delete data.scheduledStart
      delete data.scheduledEnd
    }
    if (input.isAllDay) {
      data.isAllDay = true
    }

    const updatedTask = await tasksRepository.update(userId, taskId, data)

    if (updatedTask && scheduleIntent === 'clear') {
      const sessions = await prisma.workingSession.findMany({
        where: { taskId, userId },
        select: { id: true },
      })
      for (const s of sessions) {
        await schedulingFacade.removeSession(userId, s.id).catch((err) => {
          console.error('[CLEAR_SESSIONS_ON_UPDATE]', err)
        })
      }
    } else if (updatedTask && scheduleIntent === 'set' && intentStart && intentEnd) {
      const first = await prisma.workingSession.findFirst({
        where: { taskId, userId },
        orderBy: { start: 'asc' },
        select: { id: true },
      })
      try {
        if (first) {
          await schedulingFacade.moveSession(userId, first.id, intentStart, intentEnd)
        } else {
          await schedulingFacade.createSession({
            userId,
            taskId,
            start: intentStart,
            end: intentEnd,
            createdBy: 'USER',
          })
        }
      } catch (err) {
        console.error('[FACADE_ON_UPDATE]', err)
      }
    }

    if (updatedTask) syncService.publish(userId, { type: 'task.updated', payload: { id: taskId } })

    // Auto-award XP if task is being completed for the first time
    if (input.status === 'completed' && currentTask.status !== 'completed' && updatedTask) {
      const xpAmount = currentTask.weeklyGoalId ? 40 : 15
      await gamificationService.awardXp(userId, {
        source: 'task',
        sourceId: taskId,
        amount: xpAmount,
        metadata: { taskTitle: currentTask.title },
      })
      gamificationEvents.emit('task.completed', { userId, meta: { taskId } })
      webhooksService
        .dispatch(userId, 'task.completed', {
          id: updatedTask.id,
          title: updatedTask.title,
          completedAt: (updatedTask as any).completedAt ?? new Date().toISOString(),
          priority: updatedTask.priority,
          weeklyGoalId: (updatedTask as any).weeklyGoalId ?? null,
        })
        .catch((err) => console.error('[WEBHOOK_TASK_COMPLETED]', err))
    } else if (input.status !== 'completed' && currentTask.status === 'completed') {
      gamificationEvents.emit('task.uncompleted', { userId, meta: { taskId } })
    }

    return updatedTask
  }

  /** Start time tracking for a task */
  async startTaskTimer(userId: string, taskId: string): Promise<TaskModel | null> {
    return this.updateTask(userId, taskId, {
      actualStart: new Date().toISOString(),
      actualEnd: null,
      status: 'open',
    })
  }

  /** Stop time tracking for a task */
  async stopTaskTimer(userId: string, taskId: string): Promise<TaskModel | null> {
    const task = await tasksRepository.findById(userId, taskId)
    if (!task || !task.actualStart) return null

    const startTime = new Date(task.actualStart).getTime()
    const endTime = Date.now()
    const durationSeconds = Math.round((endTime - startTime) / 1000)
    const existingSeconds = task.actualDurationSeconds || 0
    const totalSeconds = existingSeconds + durationSeconds

    return this.updateTask(userId, taskId, {
      actualEnd: new Date().toISOString(),
      actualDurationSeconds: totalSeconds,
      actualDurationMinutes: Math.round(totalSeconds / 60),
    })
  }

  /** Delete a task */
  async deleteTask(userId: string, taskId: string): Promise<boolean> {
    const ok = await tasksRepository.delete(userId, taskId)
    if (ok) syncService.publish(userId, { type: 'task.deleted', payload: { id: taskId } })
    return ok
  }

  /**
   * Suggest the next free slot of `estimatedDuration` minutes for the user
   * on `targetDate`. Reuses the same gap-finder the scheduler uses, so the
   * suggestion is consistent with what auto-schedule would actually pick.
   * Honors `preferredTime` by skipping gaps before the preferred window.
   */
  async getScheduleSuggestion(
    userId: string,
    targetDate: string, // YYYY-MM-DD
    estimatedDuration: number, // minutes
    preferredTime?: 'morning' | 'afternoon' | 'evening',
  ): Promise<{ start: string; end: string } | null> {
    const dateOnly = targetDate.includes('T') ? targetDate.split('T')[0]! : targetDate
    const settings = await prisma.userSettings.findUnique({ where: { userId } })
    const tz = settings?.timezone ?? 'UTC'
    const gapMin = settings?.autoSchedulingGapMinutes ?? 5
    const day = ymdToLocalDayUtc(dateOnly, tz)

    const window = await getDayWindow(userId, null, day)
    if (!window) return null

    const blocks = await collectBusyBlocks(userId, day, gapMin)
    const gaps = computeGaps(blocks, window.start, window.end)

    // Apply preferred-time floor (in user's tz). The first gap whose START is
    // >= preferred floor and whose duration fits the task wins.
    const prefHour =
      preferredTime === 'morning' ? 9 : preferredTime === 'afternoon' ? 13 : preferredTime === 'evening' ? 17 : null
    const prefFloor = prefHour !== null ? dt.combineDateTime(day, `${String(prefHour).padStart(2, '0')}:00`, tz) : null

    const eligible = prefFloor ? gaps.filter((g) => g.end > prefFloor) : gaps
    const target = eligible.find((g) => g.durationMinutes >= estimatedDuration) ?? gaps.find((g) => g.durationMinutes >= estimatedDuration)
    if (!target) return null

    const start = prefFloor && target.start < prefFloor ? prefFloor : target.start
    const end = dt.addMinutes(start, estimatedDuration)
    return { start: start.toISOString(), end: end.toISOString() }
  }

  // ---------------------------------------------------------------------------
  // Recurring Tasks
  // ---------------------------------------------------------------------------

  /** Calculate the next occurrence date based on a recurrence rule and reference date */
  private getNextOccurrenceDate(rule: string, fromDate: Date): Date {
    const next = new Date(fromDate)

    if (rule === 'daily') {
      next.setUTCDate(next.getUTCDate() + 1)
    } else if (rule === 'weekly') {
      next.setUTCDate(next.getUTCDate() + 7)
    } else if (rule === 'monthly') {
      next.setUTCMonth(next.getUTCMonth() + 1)
    } else if (rule === 'weekdays') {
      // Advance to the next weekday (Mon-Fri)
      do {
        next.setUTCDate(next.getUTCDate() + 1)
      } while (next.getUTCDay() === 0 || next.getUTCDay() === 6)
    } else if (rule.startsWith('custom:')) {
      // e.g. "custom:MO,WE,FR"
      const dayMap: Record<string, number> = {
        SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
      }
      const allowedDays = rule
        .replace('custom:', '')
        .split(',')
        .map((d) => dayMap[d.trim()])
        .filter((d): d is number => d !== undefined)

      if (allowedDays.length === 0) {
        // Fallback to daily if custom rule is invalid
        next.setUTCDate(next.getUTCDate() + 1)
      } else {
        // Find the next allowed day
        do {
          next.setUTCDate(next.getUTCDate() + 1)
        } while (!allowedDays.includes(next.getUTCDay()))
      }
    } else {
      // Unknown rule, default to daily
      next.setUTCDate(next.getUTCDate() + 1)
    }

    return next
  }

  /** Generate the next occurrence for a recurring parent task */
  async generateNextOccurrence(userId: string, parentTask: TaskModel): Promise<TaskModel> {
    const refDate = parentTask.scheduledDate || new Date()
    const rule = (parentTask as any).recurrenceRule || 'daily'
    const nextDate = this.getNextOccurrenceDate(rule, refDate)

    // Format to ISO date string for the repository
    const nextDateISO = nextDate.toISOString().split('T')[0]!

    return tasksRepository.create(userId, {
      title: parentTask.title,
      description: parentTask.description,
      priority: parentTask.priority,
      tags: parentTask.tags || [],
      weeklyGoalId: (parentTask as any).weeklyGoalId,
      isAllDay: parentTask.isAllDay,
      estimatedDurationMinutes: parentTask.estimatedDurationMinutes,
      scheduledDate: nextDateISO,
      recurringParentId: parentTask.id,
      source: 'recurring',
    })
  }

  /** Process all recurring tasks for a user, generating instances for today if not already created */
  async processRecurringTasks(userId: string): Promise<{ generated: TaskModel[] }> {
    const recurringTasks = await tasksRepository.findRecurringTasks(userId)
    const settings = await prisma.userSettings.findUnique({
      where: { userId },
      select: { timezone: true },
    })
    const tz = settings?.timezone ?? 'UTC'
    const today = startOfLocalDayUtc(new Date(), tz)
    const todayYmd = localYmd(new Date(), tz)

    const generated: TaskModel[] = []

    for (const parent of recurringTasks) {
      const rule = (parent as any).recurrenceRule
      if (!rule) continue

      // Check if an instance already exists for today
      const existing = await tasksRepository.findInstancesForDate(userId, parent.id, todayYmd)
      if (existing.length > 0) continue

      // Check if today is a valid day for this recurrence rule
      const todayDay = today.getUTCDay()
      let shouldGenerate = false

      if (rule === 'daily') {
        shouldGenerate = true
      } else if (rule === 'weekly') {
        // Generate if it's the same day of week as the parent's scheduled date
        const parentDay = parent.scheduledDate
          ? new Date(parent.scheduledDate).getUTCDay()
          : today.getUTCDay()
        shouldGenerate = todayDay === parentDay
      } else if (rule === 'monthly') {
        // Generate if it's the same day of month as the parent's scheduled date
        const parentDayOfMonth = parent.scheduledDate
          ? new Date(parent.scheduledDate).getUTCDate()
          : today.getUTCDate()
        shouldGenerate = today.getUTCDate() === parentDayOfMonth
      } else if (rule === 'weekdays') {
        shouldGenerate = todayDay >= 1 && todayDay <= 5
      } else if (rule.startsWith('custom:')) {
        const dayMap: Record<string, number> = {
          SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
        }
        const allowedDays = rule
          .replace('custom:', '')
          .split(',')
          .map((d: string) => dayMap[d.trim()])
          .filter((d: number | undefined): d is number => d !== undefined)
        shouldGenerate = allowedDays.includes(todayDay)
      }

      if (!shouldGenerate) continue

      // Create the instance for today
      const todayISO = today.toISOString().split('T')[0]!
      const instance = await tasksRepository.create(userId, {
        title: parent.title,
        description: parent.description,
        priority: parent.priority,
        tags: parent.tags || [],
        weeklyGoalId: (parent as any).weeklyGoalId,
        isAllDay: parent.isAllDay,
        estimatedDurationMinutes: parent.estimatedDurationMinutes,
        scheduledDate: todayISO,
        recurringParentId: parent.id,
        source: 'recurring',
      })

      generated.push(instance)
    }

    return { generated }
  }

  // ---------------------------------------------------------------------------
  // AI Methods
  // ---------------------------------------------------------------------------

  async suggestTimebox(userId: string, taskId: string) {
    const [task, history] = await Promise.all([
      tasksRepository.findById(userId, taskId),
      tasksRepository.findCompletedWithDuration(userId, 20),
    ])

    if (!task) throw new Error('Task not found')

    const historyText = history.length > 0
      ? history.map((t) => {
          const tags = Array.isArray(t.tags) ? (t.tags as string[]).join(', ') : ''
          return `- "${t.title}" | tags: ${tags || 'none'} | priority: ${t.priority || 'medium'} | estimated: ${t.estimatedDurationMinutes ?? '?'} min | actual: ${t.actualDurationMinutes} min`
        }).join('\n')
      : '(No completed tasks with duration data)'

    const result = await generateObject({
      model: taskModel,
      schema: z.object({
        suggestedMinutes: z.number().int().positive().describe('Suggested duration in minutes'),
        confidence: z.enum(['high', 'medium', 'low']).describe('Confidence level based on data quality'),
        reasoning: z.string().describe('Brief explanation of how the estimate was derived'),
        similarTasks: z.array(z.object({
          title: z.string(),
          actual: z.number(),
          estimated: z.number().nullable(),
        })).describe('Up to 3 similar past tasks used as reference'),
      }),
      prompt: `You are a time estimation assistant. Analyze this task and suggest how long it will take based on the user's historical completion data.

TARGET TASK:
- Title: ${task.title}
${task.description ? `- Description: ${task.description}` : ''}
- Priority: ${task.priority || 'medium'}
- Tags: ${Array.isArray(task.tags) ? (task.tags as string[]).join(', ') || 'none' : 'none'}
${task.estimatedDurationMinutes ? `- Current estimate: ${task.estimatedDurationMinutes} min` : ''}

COMPLETED TASKS WITH DURATION DATA (most recent first):
${historyText}

Instructions:
1. Find the most similar past tasks by title, tags, and priority.
2. Use their actual durations to calibrate your suggestion.
3. If the user consistently underestimates or overestimates, account for that bias.
4. Return up to 3 similar tasks in the similarTasks array.
5. Set confidence to "high" if there are 3+ similar tasks, "medium" if 1-2, and "low" if none match well.`,
    })

    return result.object
  }

  async estimateTimebox(
    userId: string,
    title: string,
    description?: string,
    taskId?: string,
  ): Promise<{ minutes: number; rationale: string }> {
    // Get user's recent tasks for context calibration
    const recentTasks = await tasksRepository.findMany(userId, {
      limit: 3,
    })

    const taskHistory = recentTasks
      .map((t: any) => `- ${t.title}: est ${t.estimatedDurationMinutes || '?'}m, actual ${t.actualDurationMinutes || '?'}m`)
      .join('\n')

    const result = await generateObject({
      model: fastModel,
      schema: z.object({
        minutes: z.number().int().positive(),
        rationale: z.string().max(120),
      }),
      prompt: `Estimate minutes to complete task. Short rationale.
Task: ${title}${description ? ` — ${description}` : ''}
${taskHistory ? `Recent:\n${taskHistory}` : ''}`,
    })

    // Optionally save to task if taskId provided
    if (taskId) {
      await tasksRepository.update(userId, taskId, {
        estimatedDurationMinutes: result.object.minutes,
      })
    }

    return result.object
  }

  async scheduleTask(userId: string, taskId: string, duration?: number): Promise<{ slot: { start: string; end: string } | null; confidence: number }> {
    const task = await tasksRepository.findById(userId, taskId)
    if (!task) {
      return { slot: null, confidence: 0 }
    }

    const taskDuration = duration || task.estimatedDurationMinutes || 60

    // Get today's date
    const today = new Date().toISOString().split('T')[0]!

    // Get free slots from calendar
    const result = await calendarService.getFreeSlots(userId, today, taskDuration)
    if ('error' in result || result.freeSlots.length === 0) {
      return { slot: null, confidence: 0 }
    }

    // Pick the best slot (first available for now, could be enhanced with AI)
    const bestSlot = result.freeSlots[0]
    if (!bestSlot) {
      return { slot: null, confidence: 0 }
    }

    return {
      slot: {
        start: bestSlot.start,
        end: bestSlot.end,
      },
      confidence: 0.8,
    }
  }

  async suggestNextTask(userId: string): Promise<{ taskId: string; title: string; reason: string; confidence: number } | null> {
    // Get open tasks
    const openTasks = await tasksRepository.findMany(userId, {
      status: 'open',
      limit: 20,
    })

    if (!openTasks || openTasks.length === 0) return null

    // Get active goals for context
    const weeklyGoals = await prisma.goal.findMany({
      where: { userId, horizon: 'WEEK' },
      select: { id: true, title: true },
      take: 5,
    })

    const tasksList = openTasks.map((t: any) =>
      `- [${t.id}] "${t.title}" | priority: ${t.priority || 'medium'} | due: ${t.dueDate || 'none'} | scheduled: ${t.scheduledDate || 'none'} | goal: ${t.weeklyGoalId || 'none'}`
    ).join('\n')

    const goalsList = weeklyGoals.map(g => `- [${g.id}] ${g.title}`).join('\n')

    const result = await generateObject({
      model: taskModel,
      schema: z.object({
        taskId: z.string().describe('ID of the recommended task'),
        reason: z.string().describe('Brief explanation of why this task should be done next'),
        confidence: z.number().min(0).max(1).describe('Confidence level 0-1'),
      }),
      prompt: `
You are a productivity assistant. Choose the single best task for the user to work on RIGHT NOW.

Consider:
1. Priority (high > medium > low)
2. Due date urgency (overdue or due today > due this week > no deadline)
3. Goal alignment (tasks linked to active goals get preference)
4. Scheduled date (tasks scheduled for today get high priority)

Current date: ${new Date().toISOString().split('T')[0]}

OPEN TASKS:
${tasksList}

ACTIVE GOALS:
${goalsList || '(No active goals)'}

Pick the single best task to do next. Return its exact ID from the list.
      `,
    })

    const recommended = openTasks.find((t: any) => t.id === result.object.taskId)
    if (!recommended) return null

    return {
      taskId: recommended.id,
      title: recommended.title,
      reason: result.object.reason,
      confidence: result.object.confidence,
    }
  }

  async detectScheduleConflicts(userId: string, date: string) {
    // Get tasks scheduled for this date that have specific times
    const tasks = await tasksRepository.findTodaysTasks(userId, date)
    const timedTasks = tasks.filter(t => t.scheduledStart && t.scheduledEnd)

    if (timedTasks.length === 0) return { conflicts: [], suggestions: [] }

    // Get calendar events for the date
    const startOfDay = `${date}T00:00:00Z`
    const endOfDay = `${date}T23:59:59Z`
    let calendarEvents: any[] = []
    try {
      calendarEvents = await calendarService.getGoogleEvents(userId, startOfDay, endOfDay)
    } catch {
      // Calendar not connected — can only check task-task conflicts
    }

    const conflicts: Array<{
      taskId: string
      taskTitle: string
      taskStart: string
      taskEnd: string
      conflictsWith: string
      conflictType: 'calendar_event' | 'task_overlap'
    }> = []

    // Check task vs calendar event conflicts
    for (const task of timedTasks) {
      const tStart = new Date(task.scheduledStart!).getTime()
      const tEnd = new Date(task.scheduledEnd!).getTime()

      for (const event of calendarEvents) {
        const eStart = new Date(event.start?.dateTime || event.start?.date).getTime()
        const eEnd = new Date(event.end?.dateTime || event.end?.date).getTime()

        if (tStart < eEnd && tEnd > eStart) {
          conflicts.push({
            taskId: task.id,
            taskTitle: task.title,
            taskStart: task.scheduledStart!.toISOString(),
            taskEnd: task.scheduledEnd!.toISOString(),
            conflictsWith: event.summary || 'Calendar event',
            conflictType: 'calendar_event',
          })
        }
      }

      // Check task vs task overlap
      for (const other of timedTasks) {
        if (other.id === task.id) continue
        const oStart = new Date(other.scheduledStart!).getTime()
        const oEnd = new Date(other.scheduledEnd!).getTime()

        if (tStart < oEnd && tEnd > oStart) {
          // Only add once (not symmetric)
          if (task.id < other.id) {
            conflicts.push({
              taskId: task.id,
              taskTitle: task.title,
              taskStart: task.scheduledStart!.toISOString(),
              taskEnd: task.scheduledEnd!.toISOString(),
              conflictsWith: other.title,
              conflictType: 'task_overlap',
            })
          }
        }
      }
    }

    // For each conflicting task, suggest a new time
    const suggestions: Array<{
      taskId: string
      taskTitle: string
      suggestedStart: string
      suggestedEnd: string
    }> = []

    for (const conflict of conflicts) {
      const task = timedTasks.find(t => t.id === conflict.taskId)
      if (!task) continue
      const duration = task.estimatedDurationMinutes || 60

      try {
        const suggestion = await this.getScheduleSuggestion(userId, date, duration)
        if (suggestion?.start) {
          suggestions.push({
            taskId: task.id,
            taskTitle: task.title,
            suggestedStart: suggestion.start,
            suggestedEnd: suggestion.end,
          })
        }
      } catch {
        // Skip suggestion if calendar is not available
      }
    }

    return { conflicts, suggestions }
  }

  async autoArchiveCompleted(userId: string, daysOld: number = 7): Promise<{ archived: number }> {
    const count = await tasksRepository.autoArchiveCompleted(userId, daysOld)
    return { archived: count }
  }

  // ---------------------------------------------------------------------------
  // Calendar & Timeline Views
  // ---------------------------------------------------------------------------

  /** Get tasks grouped by date for calendar rendering */
  async getCalendarView(
    userId: string,
    start: string,
    end: string,
  ): Promise<{ days: Record<string, { allDay: TaskModel[]; timed: TaskModel[] }> }> {
    const startDate = new Date(`${start}T00:00:00.000Z`)
    const endDate = new Date(`${end}T23:59:59.999Z`)

    const tasks = await tasksRepository.findByDateRange(userId, startDate, endDate)

    const days: Record<string, { allDay: TaskModel[]; timed: TaskModel[] }> = {}

    // Pre-fill every date in the range so the frontend always has an entry
    const cursor = new Date(startDate)
    while (cursor <= endDate) {
      const key = cursor.toISOString().split('T')[0]!
      days[key] = { allDay: [], timed: [] }
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }

    for (const task of tasks) {
      // Use scheduledDate first, fall back to dueDate
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

  /** Get a chronological timeline with tasks and free-time gaps */
  async getTimelineView(
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

    // Separate timed tasks (with both start and end) from the rest
    const timedTasks = tasks
      .filter((t) => t.scheduledStart && t.scheduledEnd && !t.isAllDay)
      .sort((a, b) => new Date(a.scheduledStart!).getTime() - new Date(b.scheduledStart!).getTime())

    const events: Array<{
      type: 'task' | 'gap'
      task?: TaskModel
      startTime?: string
      endTime?: string
      durationMinutes?: number
    }> = []

    // Include all-day / un-timed tasks first as task events without gap calculation
    const untimedTasks = tasks.filter(
      (t) => t.isAllDay || !t.scheduledStart || !t.scheduledEnd,
    )
    for (const task of untimedTasks) {
      events.push({ type: 'task', task })
    }

    // Build timed events with gap detection
    let previousEnd: Date | null = null

    for (const task of timedTasks) {
      const taskStart = new Date(task.scheduledStart!)
      const taskEnd = new Date(task.scheduledEnd!)

      // Insert a gap if there is free time between the previous task and this one
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

      // Track the latest end time seen so far (handles overlapping tasks)
      if (!previousEnd || taskEnd.getTime() > previousEnd.getTime()) {
        previousEnd = taskEnd
      }
    }

    return { events }
  }

  async getCompletionImpact(userId: string, taskId: string) {
    const task = await tasksRepository.findById(userId, taskId)
    if (!task || task.status !== 'completed') {
      return null
    }

    // Get goal progress if linked
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

    // Get today's productivity stats — anchored on user's local day
    const settings = await prisma.userSettings.findUnique({
      where: { userId },
      select: { timezone: true },
    })
    const tz = settings?.timezone ?? 'UTC'
    const todayStart = startOfLocalDayUtc(new Date(), tz)
    const [tasksCompletedToday, habitsCompletedToday, xpToday] = await Promise.all([
      prisma.task.count({ where: { userId, status: 'completed', completedAt: { gte: todayStart } } }),
      prisma.habitLog.count({ where: { userId, date: { gte: todayStart }, completedCount: { gt: 0 } } }),
      prisma.xpEvent.aggregate({ where: { userId, earnedDate: new Date().toISOString().split('T')[0]! }, _sum: { amount: true } }),
    ])

    // Time tracking stats
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

  async getStatistics(userId: string, days: number = 30) {
    const [completionData, counts] = await Promise.all([
      tasksRepository.getCompletionStats(userId, days),
      tasksRepository.getTaskCounts(userId),
    ])

    // Completed per day
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

    // By priority
    const byPriority: Record<string, number> = {}
    for (const task of completionData) {
      const p = task.priority || 'medium'
      byPriority[p] = (byPriority[p] || 0) + 1
    }

    // Estimate adherence
    const withEstimates = completionData.filter(
      (t) => t.estimatedDurationMinutes && t.actualDurationMinutes
    )
    const adherence = withEstimates.length > 0
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
}

export const tasksService = new TasksService()
