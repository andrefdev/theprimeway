import { OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import type { Context } from 'hono'
import type { AppEnv } from '../types/env'
import { authMiddleware } from '../middleware/auth'
import { schedulingFacade } from '../services/scheduling/scheduling-facade'
import { commandManager } from '../services/scheduling/CommandManager'
import { prisma } from '../lib/prisma'

export const schedulingRoutes = new OpenAPIHono<AppEnv>()
schedulingRoutes.use('*', authMiddleware)

const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9_-]{8,128}$/

/**
 * If the request carries a valid `Idempotency-Key` and a Command for that
 * (userId, key) already exists, return the cached result and skip execution.
 * Returns the lowercased validated key for the route to forward to the facade.
 */
async function resolveIdempotency(
  c: Context<AppEnv>,
  userId: string,
): Promise<{ replay: Response | null; key: string | undefined }> {
  const raw = c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key')
  if (!raw) return { replay: null, key: undefined }
  if (!IDEMPOTENCY_KEY_RE.test(raw)) {
    return { replay: c.json({ error: 'invalid Idempotency-Key' }, 400), key: undefined }
  }
  const existing = await commandManager.findByIdempotencyKey(userId, raw)
  if (existing) {
    const cached = (existing.payload as any)?.result
    if (cached !== undefined) {
      return { replay: c.json({ data: cached, replayed: true }), key: raw }
    }
    // Command exists but result wasn't cached (older row) — let it re-execute,
    // the unique constraint will block the duplicate INSERT and we'll fall
    // through to the catch below.
  }
  return { replay: null, key: raw }
}

const autoScheduleBody = z.object({
  taskId: z.string(),
  day: z.string(), // ISO yyyy-mm-dd
  preventSplit: z.boolean().optional(),
})

const moveSessionBody = z.object({
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  start: z.string(),
  end: z.string(),
  deconflict: z.boolean().optional(),
})

const placeSessionBody = z.object({
  taskId: z.string(),
  preferredStart: z.string(),
  duration: z.number().int().positive().optional(),
  preventSplit: z.boolean().optional(),
})

schedulingRoutes.post('/auto-schedule', async (c) => {
  const userId = (c.get('user') as any).userId as string
  const parse = autoScheduleBody.safeParse(await c.req.json())
  if (!parse.success) return c.json({ error: parse.error.message }, 400)
  const { taskId, day, preventSplit } = parse.data

  const idem = await resolveIdempotency(c, userId)
  if (idem.replay) return idem.replay

  try {
    const result = await schedulingFacade.scheduleTask(taskId, day.slice(0, 10), {
      preventSplit,
      idempotencyKey: idem.key,
    })
    return c.json({ data: result })
  } catch (err) {
    // Unique-constraint violation on idempotencyKey means a parallel request
    // beat us to it — fetch and replay the winner.
    if (idem.key && /idempotency_key|Unique constraint/i.test((err as Error).message)) {
      const existing = await commandManager.findByIdempotencyKey(userId, idem.key)
      const cached = (existing?.payload as any)?.result
      if (cached !== undefined) return c.json({ data: cached, replayed: true })
    }
    return c.json({ error: (err as Error).message }, 400)
  }
})

schedulingRoutes.post('/deconflict', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const sessionId = (body as any).sessionId as string | undefined
  if (!sessionId) return c.json({ error: 'sessionId required' }, 400)
  try {
    const result = await schedulingFacade.deconflict(sessionId)
    return c.json({ data: result })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400)
  }
})

/**
 * Move/create a session at an explicit slot — the canonical drag/drop endpoint.
 * If `sessionId` is provided, moves it. Otherwise creates a new session for `taskId`.
 * Both paths route through SchedulingFacade so Task mirror, deconflict, Google
 * push and sync events stay consistent.
 */
schedulingRoutes.post('/sessions/move', async (c) => {
  const userId = (c.get('user') as any).userId as string
  const parse = moveSessionBody.safeParse(await c.req.json())
  if (!parse.success) return c.json({ error: parse.error.message }, 400)
  const { sessionId, taskId, start, end, deconflict: doDeconflict } = parse.data
  const startDate = new Date(start)
  const endDate = new Date(end)
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return c.json({ error: 'invalid date' }, 400)
  }

  const idem = await resolveIdempotency(c, userId)
  if (idem.replay) return idem.replay

  try {
    if (sessionId) {
      const r = await schedulingFacade.moveSession(userId, sessionId, startDate, endDate, {
        deconflict: doDeconflict,
        idempotencyKey: idem.key,
      })
      if (!r.ok) return c.json({ error: r.reason }, r.reason === 'not_found' ? 404 : 400)
      return c.json({ data: { session: r.session, commandId: r.commandId } })
    }
    if (!taskId) return c.json({ error: 'sessionId or taskId required' }, 400)
    const r = await schedulingFacade.createSession(
      { userId, taskId, start: startDate, end: endDate },
      { deconflict: doDeconflict, idempotencyKey: idem.key },
    )
    return c.json({ data: { session: r.session, commandId: r.commandId } })
  } catch (err) {
    if (idem.key && /idempotency_key|Unique constraint/i.test((err as Error).message)) {
      const existing = await commandManager.findByIdempotencyKey(userId, idem.key)
      const cached = (existing?.payload as any)?.result
      if (cached !== undefined) return c.json({ data: cached, replayed: true })
    }
    return c.json({ error: (err as Error).message }, 400)
  }
})

/**
 * Place a task at a preferred slot, splitting around obstacles when the slot
 * collides with calendar events or other sessions. Returns 1+ sessions.
 *
 * `duration` is optional — defaults to the task's estimatedDurationMinutes
 * (or plannedTimeMinutes, or 30) if absent.
 */
schedulingRoutes.post('/sessions/place', async (c) => {
  const userId = (c.get('user') as any).userId as string
  const parse = placeSessionBody.safeParse(await c.req.json())
  if (!parse.success) return c.json({ error: parse.error.message }, 400)
  const { taskId, preferredStart, duration, preventSplit } = parse.data
  const startDate = new Date(preferredStart)
  if (Number.isNaN(startDate.getTime())) return c.json({ error: 'invalid date' }, 400)

  const idem = await resolveIdempotency(c, userId)
  if (idem.replay) return idem.replay

  // Resolve the duration up-front so the facade has a concrete number.
  let durMin = duration
  if (!durMin) {
    const t = await prisma.task.findFirst({
      where: { id: taskId, userId },
      select: { estimatedDurationMinutes: true, plannedTimeMinutes: true },
    })
    if (!t) return c.json({ error: 'task not found' }, 404)
    durMin = t.estimatedDurationMinutes ?? t.plannedTimeMinutes ?? 30
  }

  try {
    const result = await schedulingFacade.placeTask(taskId, startDate, durMin, {
      preventSplit,
      idempotencyKey: idem.key,
    })
    return c.json({ data: result })
  } catch (err) {
    if (idem.key && /idempotency_key|Unique constraint/i.test((err as Error).message)) {
      const existing = await commandManager.findByIdempotencyKey(userId, idem.key)
      const cached = (existing?.payload as any)?.result
      if (cached !== undefined) return c.json({ data: cached, replayed: true })
    }
    return c.json({ error: (err as Error).message }, 400)
  }
})

schedulingRoutes.post('/tasks/:id/complete-early', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { completedAt?: string }
  const at = body.completedAt ? new Date(body.completedAt) : new Date()
  const result = await schedulingFacade.reflowEarlyCompletion(id, at)
  return c.json({ data: result })
})

schedulingRoutes.post('/tasks/:id/timer-start', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { startedAt?: string }
  const at = body.startedAt ? new Date(body.startedAt) : new Date()
  const result = await schedulingFacade.onTimerStart(id, at)
  return c.json({ data: result })
})
