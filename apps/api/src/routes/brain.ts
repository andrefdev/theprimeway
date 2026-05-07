import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '../middleware/auth'
import { requireFeature } from '../middleware/feature-gate'
import { FEATURES } from '@repo/shared/constants'
import { brainService } from '../services/brain.service'
import {
  brainGraphService,
  BrainGraphFeatureError,
  ConceptMergeError,
  ConceptDeleteError,
} from '../services/brain-graph.service'

export const brainRoutes = new OpenAPIHono()

brainRoutes.use('*', authMiddleware)
brainRoutes.use('*', requireFeature(FEATURES.BRAIN_MODULE))

// GET /api/brain/entries
brainRoutes.get('/entries', async (c) => {
  const userId = (c as any).get('user').userId
  const status = c.req.query('status') ?? undefined
  const search = c.req.query('search') ?? undefined
  const limitRaw = c.req.query('limit')
  const offsetRaw = c.req.query('offset')
  const data = await brainService.list(userId, {
    status,
    search,
    limit: limitRaw ? Math.max(1, Math.min(100, Number(limitRaw))) : undefined,
    offset: offsetRaw ? Math.max(0, Number(offsetRaw)) : undefined,
  })
  return c.json({ data })
})

// GET /api/brain/entries/:id
brainRoutes.get('/entries/:id', async (c) => {
  const userId = (c as any).get('user').userId
  const result = await brainService.get(userId, c.req.param('id'))
  if (!result.ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ data: result.entry })
})

// POST /api/brain/entries
brainRoutes.post('/entries', async (c) => {
  const userId = (c as any).get('user').userId
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.content !== 'string' || !body.content.trim()) {
    return c.json({ error: 'content is required' }, 400)
  }
  const entry = await brainService.create(userId, body.content.trim())
  return c.json({ data: entry }, 201)
})

// PUT /api/brain/entries/:id (user edits: title, topics, pin, archive)
brainRoutes.put('/entries/:id', async (c) => {
  const userId = (c as any).get('user').userId
  const body = await c.req.json().catch(() => ({}))
  const patch: { userTitle?: string; topics?: string[]; isPinned?: boolean; isArchived?: boolean } = {}
  if (typeof body.userTitle === 'string') patch.userTitle = body.userTitle
  if (Array.isArray(body.topics)) patch.topics = body.topics.filter((t: unknown) => typeof t === 'string')
  if (typeof body.isPinned === 'boolean') patch.isPinned = body.isPinned
  if (typeof body.isArchived === 'boolean') patch.isArchived = body.isArchived
  const result = await brainService.userUpdate(userId, c.req.param('id'), patch)
  if (!result.ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ data: result.entry })
})

// DELETE /api/brain/entries/:id
brainRoutes.delete('/entries/:id', async (c) => {
  const userId = (c as any).get('user').userId
  const ok = await brainService.delete(userId, c.req.param('id'))
  if (!ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

// POST /api/brain/entries/:id/reprocess
brainRoutes.post('/entries/:id/reprocess', async (c) => {
  const userId = (c as any).get('user').userId
  const result = await brainService.reprocess(userId, c.req.param('id'))
  if (!result.ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ data: result.entry })
})

// ─── Concept graph (Phase 2) ─────────────────────────────────────────────
// Both endpoints additionally gate on FEATURES.BRAIN_GRAPH (paid plans).
// We check inside the handler so a clean 403 surfaces instead of a 500.

const graphRoutes = new OpenAPIHono()
graphRoutes.use('*', requireFeature(FEATURES.BRAIN_GRAPH))

// GET /api/brain/graph?since=<iso>
graphRoutes.get('/graph', async (c) => {
  const userId = (c as any).get('user').userId
  const sinceRaw = c.req.query('since')
  const since = sinceRaw ? new Date(sinceRaw) : undefined
  if (since && isNaN(since.getTime())) {
    return c.json({ error: 'Invalid since cursor' }, 400)
  }
  try {
    const data = await brainGraphService.getGraph(userId, since)
    return c.json({ data })
  } catch (err) {
    if (err instanceof BrainGraphFeatureError) {
      return c.json({ error: err.code }, 403)
    }
    throw err
  }
})

// POST /api/brain/concepts/merge — merge sourceId INTO targetId.
graphRoutes.post('/concepts/merge', async (c) => {
  const userId = (c as any).get('user').userId
  const body = await c.req.json().catch(() => ({}))
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : null
  const targetId = typeof body.targetId === 'string' ? body.targetId : null
  if (!sourceId || !targetId) {
    return c.json({ error: 'sourceId and targetId are required' }, 400)
  }
  try {
    const data = await brainGraphService.mergeConcepts(userId, sourceId, targetId)
    return c.json({ data })
  } catch (err) {
    if (err instanceof BrainGraphFeatureError) {
      return c.json({ error: err.code }, 403)
    }
    if (err instanceof ConceptMergeError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400
      return c.json({ error: err.code }, status)
    }
    throw err
  }
})

// DELETE /api/brain/concepts/:id — user-initiated concept removal from the graph.
graphRoutes.delete('/concepts/:id', async (c) => {
  const userId = (c as any).get('user').userId
  const conceptId = c.req.param('id')
  try {
    const data = await brainGraphService.deleteConcept(userId, conceptId)
    return c.json({ data })
  } catch (err) {
    if (err instanceof BrainGraphFeatureError) {
      return c.json({ error: err.code }, 403)
    }
    if (err instanceof ConceptDeleteError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 409
      return c.json({ error: err.code }, status)
    }
    throw err
  }
})

// GET /api/brain/concepts/:id/ego?depth=2
graphRoutes.get('/concepts/:id/ego', async (c) => {
  const userId = (c as any).get('user').userId
  const conceptId = c.req.param('id')
  const depthRaw = c.req.query('depth')
  const depth = depthRaw ? Number(depthRaw) : 2
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
    return c.json({ error: 'depth must be 1, 2, or 3' }, 400)
  }
  try {
    const data = await brainGraphService.getEgoNetwork(userId, conceptId, depth)
    return c.json({ data })
  } catch (err) {
    if (err instanceof BrainGraphFeatureError) {
      return c.json({ error: err.code }, 403)
    }
    throw err
  }
})

brainRoutes.route('/', graphRoutes)

// POST /api/brain/entries/:entryId/action-items/:index/apply
brainRoutes.post('/entries/:entryId/action-items/:index/apply', async (c) => {
  const userId = (c as any).get('user').userId
  const entryId = c.req.param('entryId')
  const index = Number(c.req.param('index'))
  if (!Number.isInteger(index) || index < 0) return c.json({ error: 'Invalid index' }, 400)
  const result = await brainService.applyActionItem(userId, entryId, index)
  if (!result.ok) {
    if (result.reason === 'already_applied') {
      return c.json({ error: 'Already applied', taskId: result.taskId }, 409)
    }
    return c.json({ error: 'Not found' }, 404)
  }
  return c.json({ data: { task: result.task } }, 201)
})
