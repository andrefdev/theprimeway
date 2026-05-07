/**
 * Tasks Routes — HTTP layer (thin controller)
 *
 * Responsibilities:
 * - Parse HTTP request (query params, body, path params)
 * - Call service methods
 * - Format and return HTTP response
 * - NO Prisma queries, NO business logic
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../types/env'
import { authMiddleware } from '../middleware/auth'
import { tasksService } from '../services/tasks.service'
import { parsePaginationLimit, parsePaginationOffset } from '../lib/utils'
import { LimitExceededError } from '../lib/limits'

export const taskRoutes = new OpenAPIHono<AppEnv>()

taskRoutes.use('*', authMiddleware)

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const errorResponse = z.object({ error: z.string() })

const taskSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
}).passthrough()

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  dueDate: z.string().optional(),
  scheduledDate: z.string().optional(),
  scheduledStart: z.string().optional(),
  scheduledEnd: z.string().optional(),
  isAllDay: z.boolean().optional(),
  estimatedDuration: z.number().optional(),
  acceptanceCriteria: z.string().nullish(),
  backlogState: z.string().optional(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  weeklyGoalId: z.string().optional(),
  channelId: z.string().nullish(),
  scheduledBucket: z
    .enum(['TODAY', 'TOMORROW', 'NEXT_WEEK', 'NEXT_MONTH', 'NEXT_QUARTER', 'NEXT_YEAR', 'SOMEDAY', 'NEVER'])
    .nullish(),
  isRecurring: z.boolean().optional(),
  recurrenceRule: z.string().optional(),
  recurrenceEndDate: z.string().optional(),
  /** Auto-fit into the first free gap on scheduledDate when no explicit times are provided. */
  autoSchedule: z.boolean().optional(),
})

const updateTaskSchema = createTaskSchema.partial().extend({
  status: z.enum(['open', 'completed']).optional(),
  archivedAt: z.string().nullable().optional(),
  orderInDay: z.number().optional(),
  actualStart: z.string().nullable().optional(),
  actualEnd: z.string().nullable().optional(),
  actualDurationMinutes: z.number().optional(),
  actualDurationSeconds: z.number().optional(),
  // Allow null so callers can clear scheduling (e.g. daily shutdown rollover,
  // moving a task to a bucket without a fixed date).
  scheduledDate: z.string().nullable().optional(),
  scheduledStart: z.string().nullable().optional(),
  scheduledEnd: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
})

// ---------------------------------------------------------------------------
// GET /api/tasks
// ---------------------------------------------------------------------------
const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Tasks'],
  summary: 'List tasks with filters',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.array(taskSchema), count: z.number() }) } }, description: 'Tasks list' },
  },
})

taskRoutes.openapi(listRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const q = c.req.query()

  const result = await tasksService.listTasks(userId, {
    filter: q.filter as any,
    status: q.status,
    priority: q.priority,
    referenceDate: q.referenceDate || q.reference_date,
    weeklyGoalId: q.weeklyGoalId || q.weekly_goal_id,
    weekStart: q.weekStart || q.week_start,
    weekEnd: q.weekEnd || q.week_end,
    limit: parsePaginationLimit(q.limit),
    offset: parsePaginationOffset(q.offset),
  })

  return c.json(result, 200)
}) as any)

// ---------------------------------------------------------------------------
// POST /api/tasks
// ---------------------------------------------------------------------------
const createRoute_ = createRoute({
  method: 'post',
  path: '/',
  tags: ['Tasks'],
  summary: 'Create a new task',
  security: [{ Bearer: [] }],
  request: { body: { content: { 'application/json': { schema: createTaskSchema } } } },
  responses: {
    201: { content: { 'application/json': { schema: z.object({ data: taskSchema }) } }, description: 'Task created' },
  },
})

taskRoutes.openapi(createRoute_, (async (c: any) => {
  const { userId } = c.get('user')
  const body = c.req.valid('json')
  try {
    const task = await tasksService.createTask(userId, body)
    return c.json({ data: task }, 201)
  } catch (err: any) {
    if (err instanceof LimitExceededError) {
      return c.json({ error: err.message, code: 'limit_exceeded', limitType: err.limitType }, 409)
    }
    throw err
  }
}) as any)

// ---------------------------------------------------------------------------
// GET /api/tasks/grouped
// ---------------------------------------------------------------------------
const groupedRoute = createRoute({
  method: 'get',
  path: '/grouped',
  tags: ['Tasks'],
  summary: 'Get tasks grouped by date',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ groups: z.array(z.any()), archive: z.array(taskSchema) }) } }, description: 'Grouped tasks' },
  },
})

taskRoutes.openapi(groupedRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const referenceDate = c.req.query('referenceDate') || c.req.query('reference_date')
  const startDate = c.req.query('startDate') || c.req.query('start_date')
  const endDate = c.req.query('endDate') || c.req.query('end_date')
  const autoArchiveRaw = c.req.query('autoArchive') ?? c.req.query('auto_archive')
  const autoArchive = autoArchiveRaw === undefined ? true : autoArchiveRaw !== 'false'
  const autoArchiveDaysRaw = c.req.query('autoArchiveDays') ?? c.req.query('auto_archive_days')
  const parsedDays = Number(autoArchiveDaysRaw ?? '1')
  const autoArchiveDays = Number.isFinite(parsedDays) && parsedDays >= 1 ? parsedDays : 1

  if (!referenceDate) {
    return c.json({ error: 'referenceDate query param is required' }, 400)
  }

  const result = await tasksService.getGroupedTasks(userId, referenceDate, {
    startDate,
    endDate,
    autoArchive,
    autoArchiveDays,
  })
  return c.json(result, 200)
}) as any)

// ---------------------------------------------------------------------------
// GET /api/tasks/schedule/suggest
// ---------------------------------------------------------------------------
const scheduleRoute = createRoute({
  method: 'get',
  path: '/schedule/suggest',
  tags: ['Tasks'],
  summary: 'Get schedule suggestions for a task',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.object({ start: z.string(), end: z.string() }).nullable() }) } }, description: 'Schedule suggestion' },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Invalid request' },
  },
})

taskRoutes.openapi(scheduleRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const targetDate = c.req.query('targetDate') || c.req.query('target_date')
  const estimatedDuration = c.req.query('estimatedDuration') || c.req.query('estimated_duration')
  const preferredTime = c.req.query('preferredTime') || c.req.query('preferred_time')

  if (!targetDate) {
    return c.json({ error: 'targetDate query param is required' }, 400)
  }

  if (!estimatedDuration) {
    return c.json({ error: 'estimatedDuration query param is required' }, 400)
  }

  const duration = Number(estimatedDuration)
  if (isNaN(duration) || duration <= 0) {
    return c.json({ error: 'estimatedDuration must be a positive number' }, 400)
  }

  if (preferredTime && !['morning', 'afternoon', 'evening'].includes(preferredTime)) {
    return c.json({ error: 'preferredTime must be morning, afternoon, or evening' }, 400)
  }

  try {
    const suggestion = await tasksService.getScheduleSuggestion(
      userId,
      targetDate,
      duration,
      preferredTime as 'morning' | 'afternoon' | 'evening' | undefined,
    )
    return c.json({ data: suggestion }, 200)
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to get schedule suggestion' }, 500)
  }
}) as any)

// ---------------------------------------------------------------------------
// POST /api/tasks/auto-archive
// ---------------------------------------------------------------------------
const autoArchiveRoute = createRoute({
  method: 'post',
  path: '/auto-archive',
  tags: ['Tasks'],
  summary: 'Auto-archive completed tasks older than N days',
  security: [{ Bearer: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ daysOld: z.number().int().min(1).max(90).default(7) }),
        },
      },
    },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.object({ archived: z.number() }) }) } }, description: 'Archived count' },
  },
})

taskRoutes.openapi(autoArchiveRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const { daysOld } = c.req.valid('json')
  const result = await tasksService.autoArchiveCompleted(userId, daysOld)
  return c.json({ data: result }, 200)
}) as any)

// ---------------------------------------------------------------------------
// POST /api/tasks/recurring/generate
// ---------------------------------------------------------------------------
const recurringGenerateRoute = createRoute({
  method: 'post',
  path: '/recurring/generate',
  tags: ['Tasks'],
  summary: 'Generate recurring task instances for today',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.object({ generated: z.array(taskSchema) }) }) } }, description: 'Generated recurring instances' },
  },
})

taskRoutes.openapi(recurringGenerateRoute, (async (c: any) => {
  const { userId } = c.get('user')
  try {
    const result = await tasksService.processRecurringTasks(userId)
    return c.json({ data: result }, 200)
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to generate recurring tasks' }, 500)
  }
}) as any)

// ---------------------------------------------------------------------------
// GET /api/tasks/stats
// ---------------------------------------------------------------------------
const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  tags: ['Tasks'],
  summary: 'Get task statistics',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.any() }) } }, description: 'Task statistics' },
  },
})

taskRoutes.openapi(statsRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const days = parseInt(c.req.query('days') || '30', 10)
  const data = await tasksService.getStatistics(userId, days)
  return c.json({ data }, 200)
}) as any)

// ---------------------------------------------------------------------------
// GET /api/tasks/schedule-conflicts
// ---------------------------------------------------------------------------
const scheduleConflictsRoute = createRoute({
  method: 'get',
  path: '/schedule-conflicts',
  tags: ['Tasks'],
  summary: 'Detect schedule conflicts for a date',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.any() }) } }, description: 'Conflicts and suggestions' },
  },
})

taskRoutes.openapi(scheduleConflictsRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const date = c.req.query('date') || new Date().toISOString().split('T')[0]
  const data = await tasksService.detectScheduleConflicts(userId, date)
  return c.json({ data }, 200)
}) as any)

// ---------------------------------------------------------------------------
// GET /api/tasks/views/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
// ---------------------------------------------------------------------------
const calendarViewRoute = createRoute({
  method: 'get',
  path: '/views/calendar',
  tags: ['Tasks'],
  summary: 'Get calendar view of tasks grouped by date',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.any() }) } }, description: 'Calendar view' },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Invalid request' },
  },
})

taskRoutes.openapi(calendarViewRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const start = c.req.query('start')
  const end = c.req.query('end')

  if (!start || !end) {
    return c.json({ error: 'start and end query params are required (YYYY-MM-DD)' }, 400)
  }

  const data = await tasksService.getCalendarView(userId, start, end)
  return c.json({ data }, 200)
}) as any)

// ---------------------------------------------------------------------------
// GET /api/tasks/views/timeline?start=YYYY-MM-DD&end=YYYY-MM-DD
// ---------------------------------------------------------------------------
const timelineViewRoute = createRoute({
  method: 'get',
  path: '/views/timeline',
  tags: ['Tasks'],
  summary: 'Get timeline view of tasks with free-time gaps',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.any() }) } }, description: 'Timeline view' },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Invalid request' },
  },
})

taskRoutes.openapi(timelineViewRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const start = c.req.query('start')
  const end = c.req.query('end')

  if (!start || !end) {
    return c.json({ error: 'start and end query params are required (YYYY-MM-DD)' }, 400)
  }

  const data = await tasksService.getTimelineView(userId, start, end)
  return c.json({ data }, 200)
}) as any)

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/timer/start
// ---------------------------------------------------------------------------
const startTimerRoute = createRoute({
  method: 'post',
  path: '/:id/timer/start',
  tags: ['Tasks'],
  summary: 'Start time tracking for a task',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: taskSchema }) } }, description: 'Timer started' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Not found' },
  },
})

taskRoutes.openapi(startTimerRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const taskId = c.req.param('id')
  const task = await tasksService.startTaskTimer(userId, taskId)
  if (!task) return c.json({ error: 'Task not found' }, 404)
  return c.json({ data: task }, 200)
}) as any)

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/timer/stop
// ---------------------------------------------------------------------------
const stopTimerRoute = createRoute({
  method: 'post',
  path: '/:id/timer/stop',
  tags: ['Tasks'],
  summary: 'Stop time tracking for a task',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: taskSchema }) } }, description: 'Timer stopped' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Not found or not started' },
  },
})

taskRoutes.openapi(stopTimerRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const taskId = c.req.param('id')
  const task = await tasksService.stopTaskTimer(userId, taskId)
  if (!task) return c.json({ error: 'Task not found or timer not started' }, 404)
  return c.json({ data: task }, 200)
}) as any)

// ---------------------------------------------------------------------------
// GET /api/tasks/:id/impact
// ---------------------------------------------------------------------------
const impactRoute = createRoute({
  method: 'get',
  path: '/:id/impact',
  tags: ['Tasks'],
  summary: 'Get completion impact for a task',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.any() }) } }, description: 'Completion impact' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Not found or not completed' },
  },
})

taskRoutes.openapi(impactRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const taskId = c.req.param('id')
  const data = await tasksService.getCompletionImpact(userId, taskId)
  if (!data) return c.json({ error: 'Task not found or not completed' }, 404)
  return c.json({ data }, 200)
}) as any)

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------
const getRoute = createRoute({
  method: 'get',
  path: '/:id',
  tags: ['Tasks'],
  summary: 'Get a single task',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: taskSchema }) } }, description: 'Task found' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Not found' },
  },
})

taskRoutes.openapi(getRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const task = await tasksService.getTask(userId, c.req.param('id'))
  if (!task) return c.json({ error: 'Task not found' }, 404)
  return c.json({ data: task }, 200)
}) as any)

// ---------------------------------------------------------------------------
// PUT /api/tasks/:id
// ---------------------------------------------------------------------------
const updateRoute = createRoute({
  method: 'put',
  path: '/:id',
  tags: ['Tasks'],
  summary: 'Update a task',
  security: [{ Bearer: [] }],
  request: { body: { content: { 'application/json': { schema: updateTaskSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: taskSchema }) } }, description: 'Task updated' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Not found' },
  },
})

taskRoutes.openapi(updateRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const body = c.req.valid('json')

  try {
    const task = await tasksService.updateTask(userId, c.req.param('id'), body)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    return c.json({ data: task }, 200)
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
}) as any)

// ---------------------------------------------------------------------------
// DELETE /api/tasks/:id
// ---------------------------------------------------------------------------
const deleteRoute = createRoute({
  method: 'delete',
  path: '/:id',
  tags: ['Tasks'],
  summary: 'Delete a task',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ success: z.boolean() }) } }, description: 'Task deleted' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Not found' },
  },
})

taskRoutes.openapi(deleteRoute, async (c) => {
  const { userId } = c.get('user')
  const deleted = await tasksService.deleteTask(userId, c.req.param('id'))
  if (!deleted) return c.json({ error: 'Task not found' }, 404)
  return c.json({ success: true }, 200)
})

// ---------------------------------------------------------------------------
// GET /api/tasks/ai/timebox — Suggest timebox from similar past tasks
// ---------------------------------------------------------------------------
const suggestTimeboxRoute = createRoute({
  method: 'get',
  path: '/ai/timebox',
  tags: ['Tasks', 'AI'],
  summary: 'Suggest time estimate based on similar completed tasks',
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              suggestedMinutes: z.number(),
              confidence: z.enum(['high', 'medium', 'low']),
              reasoning: z.string(),
              similarTasks: z.array(z.object({
                title: z.string(),
                actual: z.number(),
                estimated: z.number().nullable(),
              })),
            }),
          }),
        },
      },
      description: 'Timebox suggestion',
    },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Missing taskId' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Task not found' },
  },
})

taskRoutes.openapi(suggestTimeboxRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const taskId = c.req.query('taskId')

  if (!taskId) {
    return c.json({ error: 'taskId query param is required' }, 400)
  }

  try {
    const result = await tasksService.suggestTimebox(userId, taskId)
    return c.json({ data: result }, 200)
  } catch (err: any) {
    if (err.message === 'Task not found') {
      return c.json({ error: 'Task not found' }, 404)
    }
    console.error('[SUGGEST_TIMEBOX_ERROR]', err)
    return c.json({ error: 'Failed to suggest timebox', details: err.message }, 400)
  }
}) as any)

// ---------------------------------------------------------------------------
// POST /api/tasks/ai/timebox
// ---------------------------------------------------------------------------
const timeboxRoute = createRoute({
  method: 'post',
  path: '/ai/timebox',
  tags: ['Tasks', 'AI'],
  summary: 'Estimate task duration using AI',
  security: [{ Bearer: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string(),
            description: z.string().optional(),
            taskId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            minutes: z.number(),
            rationale: z.string(),
          }),
        },
      },
      description: 'Timebox estimate',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponse,
        },
      },
      description: 'Failed to estimate timebox',
    },
  },
})

taskRoutes.openapi(timeboxRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const { title, description, taskId } = c.req.valid('json')

  try {
    const result = await tasksService.estimateTimebox(userId, title, description, taskId)
    return c.json({ data: result }, 200)
  } catch (err) {
    console.error('[TIMEBOX_ERROR]', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: 'Failed to estimate timebox', details: message }, 400)
  }
}) as any)

// ---------------------------------------------------------------------------
// POST /api/tasks/ai/schedule
// ---------------------------------------------------------------------------
const aiScheduleRoute = createRoute({
  method: 'post',
  path: '/ai/schedule',
  tags: ['Tasks', 'AI'],
  summary: 'Find optimal time slot for task',
  security: [{ Bearer: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            taskId: z.string(),
            duration: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            slot: z
              .object({
                start: z.string(),
                end: z.string(),
              })
              .nullable(),
            confidence: z.number(),
          }),
        },
      },
      description: 'Scheduling suggestion',
    },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Task not found' },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Failed to schedule task' },
  },
})

taskRoutes.openapi(aiScheduleRoute, (async (c: any) => {
  const { userId } = c.get('user')
  const { taskId, duration } = c.req.valid('json')

  const result = await tasksService.scheduleTask(userId, taskId, duration)
  return c.json(result, 200)
}) as any)

// ---------------------------------------------------------------------------
// GET /api/tasks/ai/next
// ---------------------------------------------------------------------------
const nextTaskRoute = createRoute({
  method: 'get',
  path: '/ai/next',
  tags: ['Tasks', 'AI'],
  summary: 'Get AI recommendation for next task to work on',
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              taskId: z.string(),
              title: z.string(),
              reason: z.string(),
              confidence: z.number(),
            }).nullable(),
          }),
        },
      },
      description: 'Next task recommendation',
    },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Failed to suggest' },
  },
})

taskRoutes.openapi(nextTaskRoute, (async (c: any) => {
  const { userId } = c.get('user')

  try {
    const result = await tasksService.suggestNextTask(userId)
    return c.json({ data: result }, 200)
  } catch (err) {
    console.error('[NEXT_TASK_ERROR]', err)
    return c.json({ error: 'Failed to suggest next task' }, 400)
  }
}) as any)
