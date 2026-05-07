/**
 * Calendar Routes — HTTP layer (thin controller)
 *
 * Responsibilities:
 * - Parse HTTP request
 * - Call service methods
 * - Format and return HTTP response
 * - NO Prisma queries, NO business logic
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { updateCalendarSchema, googleCallbackSchema, syncCalendarSchema } from '@repo/shared/validators'
import { authMiddleware } from '../middleware/auth'
import { calendarService } from '../services/calendar.service'
import type { AppEnv } from '../types/env'

export const calendarRoutes = new OpenAPIHono<AppEnv>()

// --- Unauthenticated Google push webhook (must be registered before authMiddleware) ---
calendarRoutes.post('/google/webhook', async (c) => {
  const channelId = c.req.header('x-goog-channel-id') || c.req.header('X-Goog-Channel-ID')
  const resourceId = c.req.header('x-goog-resource-id') || c.req.header('X-Goog-Resource-ID')
  const resourceState =
    c.req.header('x-goog-resource-state') || c.req.header('X-Goog-Resource-State')
  const token = c.req.header('x-goog-channel-token') || c.req.header('X-Goog-Channel-Token')

  try {
    const result = await calendarService.handleWatchNotification({
      channelId,
      resourceId,
      resourceState,
      token,
    })
    if (!result.ok) {
      console.warn('[CAL_WEBHOOK] handle returned not-ok', {
        channelId,
        resourceState,
        reason: result.reason,
      })
    } else {
      console.log('[CAL_WEBHOOK] processed', { channelId, resourceState })
    }
  } catch (err) {
    console.error('[CAL_WEBHOOK] exception', { channelId, resourceState, err })
  }

  // Always 200: Google retries on 5xx and we don't want it pounding us when
  // the failure is permanent on our side. Errors land in logs above.
  return c.body(null, 200)
})

calendarRoutes.use('*', authMiddleware)

const errorResponse = z.object({ error: z.string() })

// ---------------------------------------------------------------------------
// GET /accounts
// ---------------------------------------------------------------------------
const listAccountsRoute = createRoute({
  method: 'get',
  path: '/accounts',
  tags: ['Calendar'],
  summary: 'List calendar accounts',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.array(z.any()) }) } }, description: 'Calendar accounts' },
  },
})

calendarRoutes.openapi(listAccountsRoute, (async (c: any) => {
  const userId = c.get('user').userId
  const accounts = await calendarService.listAccounts(userId)
  return c.json({ data: accounts }, 200)
}) as any)

// ---------------------------------------------------------------------------
// DELETE /accounts
// ---------------------------------------------------------------------------
const deleteAccountRoute = createRoute({
  method: 'delete',
  path: '/accounts',
  tags: ['Calendar'],
  summary: 'Delete a calendar account',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ success: z.boolean() }) } }, description: 'Deleted' },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Missing id' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Not found' },
  },
})

calendarRoutes.openapi(deleteAccountRoute, async (c) => {
  const userId = c.get('user').userId
  const id = c.req.query('id')

  if (!id) return c.json({ error: 'Missing id parameter' }, 400)

  const result = await calendarService.deleteAccount(userId, id)
  if (!result) return c.json({ error: 'Not found or unauthorized' }, 404)
  return c.json({ success: true }, 200)
})

// ---------------------------------------------------------------------------
// GET /free-time — Analyze free time across a date range
// ---------------------------------------------------------------------------
const freeTimeRoute = createRoute({
  method: 'get',
  path: '/free-time',
  tags: ['Calendar'],
  summary: 'Analyze free time slots across a date range',
  security: [{ Bearer: [] }],
  request: {
    query: z.object({
      start: z.string().optional().describe('Start date YYYY-MM-DD (defaults to today)'),
      end: z.string().optional().describe('End date YYYY-MM-DD (defaults to end of week)'),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            days: z.array(
              z.object({
                date: z.string(),
                totalFreeMinutes: z.number(),
                totalBusyMinutes: z.number(),
                longestFreeBlock: z.number(),
                freeSlots: z.array(
                  z.object({
                    start: z.string(),
                    end: z.string(),
                    durationMinutes: z.number(),
                  }),
                ),
                eventCount: z.number(),
              }),
            ),
            summary: z.object({
              avgFreeMinutesPerDay: z.number(),
              busiestDay: z.string(),
              freestDay: z.string(),
              totalFreeHours: z.number(),
            }),
          }),
        },
      },
      description: 'Free time analysis',
    },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Invalid date' },
  },
})

calendarRoutes.openapi(freeTimeRoute, async (c) => {
  const userId = c.get('user').userId
  let { start, end } = c.req.valid('query')

  // Default: today through end of current week (Sunday)
  if (!start) {
    start = new Date().toISOString().split('T')[0]!
  }
  if (!end) {
    const today = new Date()
    const daysUntilSunday = 7 - today.getDay()
    const sunday = new Date(today)
    sunday.setDate(today.getDate() + daysUntilSunday)
    end = sunday.toISOString().split('T')[0]!
  }

  // Validate date formats
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return c.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, 400)
  }

  if (new Date(start) > new Date(end)) {
    return c.json({ error: 'Start date must be before or equal to end date' }, 400)
  }

  const result = await calendarService.analyzeFreeTime(userId, start, end)
  return c.json(result, 200)
})

// ---------------------------------------------------------------------------
// GET /ai/time-blocks — AI-generated time-block suggestions for the day
// ---------------------------------------------------------------------------
const aiTimeBlocksRoute = createRoute({
  method: 'get',
  path: '/ai/time-blocks',
  tags: ['Calendar'],
  summary: 'AI generates optimal time-block suggestions for scheduling tasks into the day',
  security: [{ Bearer: [] }],
  request: {
    query: z.object({
      date: z.string().describe('Date in YYYY-MM-DD format'),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              blocks: z.array(
                z.object({
                  taskId: z.string(),
                  taskTitle: z.string(),
                  startTime: z.string(),
                  endTime: z.string(),
                  reason: z.string(),
                }),
              ),
              unscheduled: z.array(
                z.object({
                  taskId: z.string(),
                  taskTitle: z.string(),
                  reason: z.string(),
                }),
              ),
            }),
          }),
        },
      },
      description: 'AI-generated time-block suggestions',
    },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Invalid date format' },
  },
})

calendarRoutes.openapi(aiTimeBlocksRoute, async (c) => {
  const userId = c.get('user').userId
  const { date } = c.req.valid('query')

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, 400)
  }

  const result = await calendarService.generateTimeBlocks(userId, date)
  return c.json({ data: result }, 200)
})

// ---------------------------------------------------------------------------
// GET /ai/smart-slots — AI suggests optimal time slots for a task
// ---------------------------------------------------------------------------
const aiSmartSlotsRoute = createRoute({
  method: 'get',
  path: '/ai/smart-slots',
  tags: ['Calendar'],
  summary: 'AI suggests optimal time slots for a task based on calendar, task type, and energy patterns',
  security: [{ Bearer: [] }],
  request: {
    query: z.object({
      taskId: z.string().describe('Task ID to find slots for'),
      date: z.string().describe('Date in YYYY-MM-DD format'),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              slots: z.array(
                z.object({
                  startTime: z.string(),
                  endTime: z.string(),
                  score: z.number(),
                  reason: z.string(),
                }),
              ),
              bestSlot: z.object({
                startTime: z.string(),
                endTime: z.string(),
                reason: z.string(),
              }),
            }),
          }),
        },
      },
      description: 'AI-suggested optimal time slots',
    },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Invalid input' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Task not found' },
  },
})

calendarRoutes.openapi(aiSmartSlotsRoute, (async (c: any) => {
  const userId = c.get('user').userId
  const { taskId, date } = c.req.valid('query')

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, 400)
  }

  if (!taskId) {
    return c.json({ error: 'Missing taskId parameter' }, 400)
  }

  const result = await calendarService.findSmartSlots(userId, taskId, date)

  if ('error' in result) {
    if (result.error === 'task_not_found') {
      return c.json({ error: 'Task not found' }, 404)
    }
  }

  return c.json({ data: result }, 200)
}) as any)

// ---------------------------------------------------------------------------
// PATCH /calendars/:id
// ---------------------------------------------------------------------------
const updateCalendarRoute = createRoute({
  method: 'patch',
  path: '/calendars/:id',
  tags: ['Calendar'],
  summary: 'Update a calendar',
  security: [{ Bearer: [] }],
  request: { body: { content: { 'application/json': { schema: updateCalendarSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.any() }) } }, description: 'Updated' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'Not found' },
  },
})

calendarRoutes.openapi(updateCalendarRoute, (async (c: any) => {
  const userId = c.get('user').userId
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const result = await calendarService.updateCalendar(userId, id, body)

  if ('error' in result) {
    if (result.error === 'not_found') return c.json({ error: 'Not found' }, 404)
    if (result.error === 'unauthorized') return c.json({ error: 'Unauthorized' }, 401)
  }

  return c.json({ data: (result as any).data }, 200)
}) as any)

// ---------------------------------------------------------------------------
// GET /google/connect
// ---------------------------------------------------------------------------
const googleConnectRoute = createRoute({
  method: 'get',
  path: '/google/connect',
  tags: ['Calendar'],
  summary: 'Get Google OAuth URL',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ url: z.string() }) } }, description: 'OAuth URL' },
    500: { content: { 'application/json': { schema: errorResponse } }, description: 'Not configured' },
  },
})

calendarRoutes.openapi(googleConnectRoute, async (c) => {
  const url = calendarService.getGoogleOAuthUrl()
  if (!url) return c.json({ error: 'Google Calendar not configured' }, 500)
  return c.json({ url }, 200)
})

// ---------------------------------------------------------------------------
// POST /google/callback
// ---------------------------------------------------------------------------
const googleCallbackRoute = createRoute({
  method: 'post',
  path: '/google/callback',
  tags: ['Calendar'],
  summary: 'Handle Google OAuth callback',
  security: [{ Bearer: [] }],
  request: { body: { content: { 'application/json': { schema: googleCallbackSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.any() }) } }, description: 'Connected' },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Invalid code' },
  },
})

calendarRoutes.openapi(googleCallbackRoute, (async (c: any) => {
  const userId = c.get('user').userId
  const { code } = c.req.valid('json')

  const result = await calendarService.handleGoogleCallback(userId, code)

  if ('error' in result) {
    const detail = (result as any).detail
    const message = detail ? `${result.error}: ${detail}` : result.error
    const status = result.error === 'not_configured' ? 500 : 400
    console.error('[GOOGLE_CALLBACK_ROUTE]', message)
    return c.json({ error: message, code: result.error }, status)
  }

  return c.json({ data: (result as any).data }, 200)
}) as any)

// ---------------------------------------------------------------------------
// GET /google/events
// ---------------------------------------------------------------------------
const googleEventsRoute = createRoute({
  method: 'get',
  path: '/google/events',
  tags: ['Calendar'],
  summary: 'Get Google Calendar events',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.array(z.any()) }) } }, description: 'Events' },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Missing params' },
  },
})

calendarRoutes.openapi(googleEventsRoute, (async (c: any) => {
  const userId = c.get('user').userId
  const timeMin = c.req.query('timeMin')
  const timeMax = c.req.query('timeMax')

  if (!timeMin || !timeMax) return c.json({ error: 'Missing timeMin or timeMax' }, 400)

  // Source of truth for "external events" is the local CalendarEvent cache,
  // kept fresh by Google webhooks + the `syncCalendars` job. Falling back to
  // a live fetch on every UI render created the inconsistency the planner saw
  // (UI sees event X, scheduler doesn't).
  const allEvents = await calendarService.listCachedEventsForUi(
    userId,
    new Date(timeMin),
    new Date(timeMax),
  )
  return c.json({ data: allEvents }, 200)
}) as any)

// ---------------------------------------------------------------------------
// POST /google/import
// ---------------------------------------------------------------------------
const googleImportRoute = createRoute({
  method: 'post',
  path: '/google/import',
  tags: ['Calendar'],
  summary: 'Import Google Calendar',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ data: z.any() }) } }, description: 'Imported' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'No account found' },
  },
})

calendarRoutes.openapi(googleImportRoute, async (c) => {
  const userId = c.get('user').userId
  const account = await calendarService.importGoogleCalendar(userId)
  if (!account) return c.json({ error: 'No Google Auth account found with refresh token' }, 404)
  return c.json({ data: account }, 200)
})

// ---------------------------------------------------------------------------
// POST /sync
// ---------------------------------------------------------------------------
const syncRoute = createRoute({
  method: 'post',
  path: '/sync',
  tags: ['Calendar'],
  summary: 'Sync calendars',
  security: [{ Bearer: [] }],
  request: { body: { content: { 'application/json': { schema: syncCalendarSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Sync result' },
  },
})

calendarRoutes.openapi(syncRoute, async (c) => {
  const userId = c.get('user').userId
  const body = c.req.valid('json')
  const calendarId = body.calendarId || body.calendar_id
  const result = await calendarService.syncCalendars(userId, calendarId)
  return c.json(result, 200)
})

// ---------------------------------------------------------------------------
// POST /resubscribe — Recreate Google watch channels for the user's selected
// calendars. Idempotent: keeps healthy channels (have syncToken + not expired)
// and only rebuilds the broken ones.
// ---------------------------------------------------------------------------
const resubscribeRoute = createRoute({
  method: 'post',
  path: '/resubscribe',
  tags: ['Calendar'],
  summary: 'Re-subscribe Google push notification channels for this user',
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Resubscribe result' },
  },
})

calendarRoutes.openapi(resubscribeRoute, async (c) => {
  const userId = c.get('user').userId
  const result = await calendarService.resubscribeWatchChannelsForUser(userId)
  return c.json({ data: result }, 200)
})

// ---------------------------------------------------------------------------
// POST /time-block — Create a time block in Google Calendar
// ---------------------------------------------------------------------------
const timeBlockRoute = createRoute({
  method: 'post',
  path: '/time-block',
  tags: ['Calendar'],
  summary: 'Create a time block in Google Calendar for a task or habit',
  security: [{ Bearer: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
            startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM'),
            endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM'),
            description: z.string().optional(),
            color: z.string().optional(),
            timeZone: z.string().optional(),
            location: z.string().optional(),
            attendees: z.array(z.object({ email: z.string().email() })).optional(),
            reminders: z
              .object({
                useDefault: z.boolean(),
                overrides: z
                  .array(
                    z.object({
                      method: z.enum(['popup', 'email']),
                      minutes: z.number().int().min(0),
                    }),
                  )
                  .optional(),
              })
              .optional(),
            addGoogleMeet: z.boolean().optional(),
            calendarId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              success: z.boolean(),
              eventId: z.string().optional(),
            }),
          }),
        },
      },
      description: 'Time block created',
    },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Invalid input' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'No Google Calendar connected' },
  },
})

calendarRoutes.openapi(timeBlockRoute, (async (c: any) => {
  const userId = c.get('user').userId
  const body = c.req.valid('json')

  const result = await calendarService.createTimeBlock(userId, body)

  if (!result.success) {
    if (result.error === 'no_google_account' || result.error === 'no_calendar') {
      return c.json({ error: 'No Google Calendar connected' }, 404)
    }
    if (result.error === 'calendar_read_only') {
      return c.json(
        {
          error: 'calendar_read_only',
          message: 'This calendar is read-only and cannot accept new events. Please pick a different calendar.',
        },
        400,
      )
    }
    return c.json({ error: result.error || 'Failed to create time block' }, 400)
  }

  return c.json(
    {
      data: {
        success: true,
        eventId: result.eventId,
        hangoutLink: result.hangoutLink,
        htmlLink: result.htmlLink,
      },
    },
    201,
  )
}) as any)

// ---------------------------------------------------------------------------
// GET /events/:calendarId/:eventId — fetch a single Google Calendar event
// PATCH /events/:calendarId/:eventId — update arbitrary Google Calendar event
// DELETE /events/:calendarId/:eventId — delete arbitrary Google Calendar event
// ---------------------------------------------------------------------------
const eventPatchSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timeZone: z.string().optional(),
  colorId: z.string().optional(),
  attendees: z.array(z.object({ email: z.string().email() })).optional(),
  addGoogleMeet: z.boolean().optional(),
  removeGoogleMeet: z.boolean().optional(),
  reminders: z
    .object({
      useDefault: z.boolean(),
      overrides: z
        .array(
          z.object({
            method: z.enum(['popup', 'email']),
            minutes: z.number().int().min(0),
          }),
        )
        .optional(),
    })
    .optional(),
  visibility: z.enum(['default', 'public', 'private', 'confidential']).optional(),
})

calendarRoutes.get('/events/:calendarId/:eventId', async (c) => {
  const userId = (c.get('user') as any).userId
  const calendarId = decodeURIComponent(c.req.param('calendarId'))
  const eventId = decodeURIComponent(c.req.param('eventId'))
  const result = await calendarService.getGoogleEvent(userId, calendarId, eventId)
  if (!result.success) {
    return c.json({ error: result.error || 'failed' }, result.error === 'not_found' ? 404 : 400)
  }
  return c.json({ data: result.event }, 200)
})

calendarRoutes.patch('/events/:calendarId/:eventId', async (c) => {
  const userId = (c.get('user') as any).userId
  const calendarId = decodeURIComponent(c.req.param('calendarId'))
  const eventId = decodeURIComponent(c.req.param('eventId'))
  const raw = await c.req.json().catch(() => ({}))
  const parsed = eventPatchSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', issues: parsed.error.flatten() }, 400)
  }
  const result = await calendarService.updateGoogleEvent(userId, calendarId, eventId, parsed.data)
  if (!result.success) {
    return c.json({ error: result.error || 'failed' }, result.error === 'not_found' ? 404 : 400)
  }
  return c.json({ data: result.event }, 200)
})

calendarRoutes.delete('/events/:calendarId/:eventId', async (c) => {
  const userId = (c.get('user') as any).userId
  const calendarId = decodeURIComponent(c.req.param('calendarId'))
  const eventId = decodeURIComponent(c.req.param('eventId'))
  const result = await calendarService.deleteGoogleEvent(userId, calendarId, eventId)
  if (!result.success) {
    return c.json({ error: result.error || 'failed' }, result.error === 'not_found' ? 404 : 400)
  }
  return c.json({ data: { success: true } }, 200)
})

// ---------------------------------------------------------------------------
// POST /habit-block — Create a recurring calendar block for a habit
// ---------------------------------------------------------------------------
const habitBlockRoute = createRoute({
  method: 'post',
  path: '/habit-block',
  tags: ['Calendar'],
  summary: 'Create recurring calendar block for a habit',
  security: [{ Bearer: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            habitId: z.string(),
            habitName: z.string(),
            startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM'),
            endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM'),
            frequencyType: z.enum(['daily', 'weekly']),
            weekDays: z.array(z.string()).optional(),
            description: z.string().optional(),
            color: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              success: z.boolean(),
              eventId: z.string().optional(),
            }),
          }),
        },
      },
      description: 'Habit block created',
    },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Invalid input' },
    404: { content: { 'application/json': { schema: errorResponse } }, description: 'No Google Calendar connected' },
  },
})

calendarRoutes.openapi(habitBlockRoute, (async (c: any) => {
  const userId = c.get('user').userId
  const body = c.req.valid('json')

  const result = await calendarService.createHabitBlock(userId, body)

  if (!result.success) {
    if (result.error === 'no_google_account' || result.error === 'no_calendar') {
      return c.json({ error: 'No Google Calendar connected' }, 404)
    }
    return c.json({ error: result.error || 'Failed to create habit block' }, 400)
  }

  return c.json({ data: { success: true, eventId: result.eventId } }, 201)
}) as any)

// ---------------------------------------------------------------------------
// GET /free-slots
// ---------------------------------------------------------------------------
const freeSlotsRoute = createRoute({
  method: 'get',
  path: '/free-slots',
  tags: ['Calendar'],
  summary: 'Get free calendar slots for scheduling',
  security: [{ Bearer: [] }],
  request: {
    query: z.object({
      date: z.string().describe('Date in YYYY-MM-DD format'),
      duration: z.coerce.number().int().positive().describe('Duration in minutes'),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            freeSlots: z.array(
              z.object({
                start: z.string().describe('ISO 8601 timestamp'),
                end: z.string().describe('ISO 8601 timestamp'),
                durationMinutes: z.number(),
              }),
            ),
          }),
        },
      },
      description: 'Free time slots',
    },
    400: { content: { 'application/json': { schema: errorResponse } }, description: 'Missing params or invalid date' },
  },
})

calendarRoutes.openapi(freeSlotsRoute, async (c) => {
  const userId = c.get('user').userId
  const { date, duration } = c.req.valid('query')

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, 400)
  }

  const result = await calendarService.getFreeSlots(userId, date, duration)

  if ('error' in result) {
    if (result.error === 'no_work_preferences') {
      return c.json({ error: 'User has not set up work preferences' }, 400)
    }
  }

  return c.json(result, 200)
})

// ---------------------------------------------------------------------------
// PATCH /accounts/:id — update account (e.g. defaultTargetCalendarId)
// ---------------------------------------------------------------------------
calendarRoutes.patch('/accounts/:id', async (c: any) => {
  const userId = c.get('user').userId
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))

  const account = await calendarService.updateAccountSettings(userId, id, body)
  if (!account) return c.json({ error: 'Not found or unauthorized' }, 404)
  return c.json({ data: account }, 200)
})

// ---------------------------------------------------------------------------
// GET /events — cached CalendarEvent rows for the user within [from, to]
// Used by the Compass surface to render busy blocks alongside WorkingSessions.
// ---------------------------------------------------------------------------
calendarRoutes.get('/events', async (c) => {
  const userId = c.get('user').userId
  const from = c.req.query('from')
  const to = c.req.query('to')
  if (!from || !to) return c.json({ error: 'from and to required' }, 400)
  const events = await calendarService.listEventsInRange(userId, new Date(from), new Date(to))
  return c.json({ data: events })
})

