/**
 * Place a task at a user's preferred slot, splitting around obstacles when
 * needed so the full duration fits without colliding with calendar events
 * or existing sessions.
 *
 * Why this exists alongside `auto-schedule`: auto-schedule answers "fit this
 * task in the next free slot starting from now/dayStart". Place-task answers
 * "fit this task as close as possible to *this* time", which is the mental
 * model behind a calendar drag-drop. The user's preferred time anchors the
 * placement; gaps closer to it are filled first.
 *
 * Worked example (the case from production feedback):
 *   - Now: 3:00 PM. Event blocks 3:30–4:00. Working hours 9–5.
 *   - User drops a 60-min task at 3:00.
 *   - Result: two sessions, [3:00–3:30] + [4:00–4:30]. Total 60 min, hugging
 *     the anchor on both sides of the obstacle.
 *
 * Spec & related: docs/TASK_SCHEDULER_ALGO.md §4–5.
 */
import { prisma } from '../../lib/prisma'
import { collectBusyBlocks, computeGaps, getDayWindow, Gap } from './gap-finder'
import { commandManager, CommandChange } from './CommandManager'
import {
  pushSessionToCalendar,
  removeSessionFromCalendar,
} from '../calendar/session-push.service'
import { syncTaskMirror } from './task-mirror'

export interface PlaceTaskOptions {
  /** Block splitting; if the slot can't hold the whole task, return Overcommitted. */
  preventSplit?: boolean
  /** Override Command.triggeredBy. Default 'USER_ACTION'. */
  triggeredBy?: 'USER_ACTION' | 'AUTO_RESCHEDULER' | 'ROLLOVER_JOB' | 'SYNC_JOB'
  /** Idempotency key recorded on the Command so retries replay the same result. */
  idempotencyKey?: string
}

export type PlaceTaskResult =
  | {
      type: 'Success'
      sessions: Array<{ id: string; start: Date; end: Date }>
      commandId: string
    }
  | {
      type: 'Overcommitted'
      reason: 'NO_WORKING_HOURS' | 'NO_GAPS' | 'WOULD_NOT_FIT'
      options: string[]
    }

interface Chunk {
  start: Date
  end: Date
}

const MIN_CHUNK_MS = 15 * 60_000

// ---------------------------------------------------------------------------
// Pure planner — extracted so it can be unit-tested without DB.
// ---------------------------------------------------------------------------

/**
 * Plan a placement for `durationMinutes` of work, anchored at `anchor`.
 * Strategy:
 *   1. If a single contiguous gap contains [anchor, anchor+duration], use it.
 *   2. Otherwise, sort gaps by closest-point distance to the anchor. Walk
 *      gaps in that order, taking from each the portion nearest the anchor:
 *        - gaps strictly before the anchor → take from the END (so the chunk
 *          finishes right where the obstacle begins)
 *        - gaps strictly after the anchor → take from the START (so the chunk
 *          begins right where the obstacle ends)
 *        - gap containing the anchor → start the chunk at the anchor itself
 *      Stop when the remaining duration is filled.
 *
 * Returns null when `durationMinutes` won't fit (sum of usable gaps too small)
 * or `preventSplit` was requested but a single chunk wouldn't fit.
 */
export function planAroundAnchor(
  gaps: Gap[],
  anchor: Date,
  durationMinutes: number,
  preventSplit: boolean,
): Chunk[] | null {
  const anchorMs = anchor.getTime()
  const requiredMs = durationMinutes * 60_000

  // Single contiguous chunk starting at anchor.
  for (const g of gaps) {
    if (g.start.getTime() <= anchorMs && g.end.getTime() >= anchorMs + requiredMs) {
      return [{ start: anchor, end: new Date(anchorMs + requiredMs) }]
    }
  }

  if (preventSplit) return null

  const sorted = [...gaps].sort(
    (a, b) => distanceFromAnchor(a, anchorMs) - distanceFromAnchor(b, anchorMs),
  )

  const chunks: Chunk[] = []
  let remainingMs = requiredMs

  for (const gap of sorted) {
    if (remainingMs <= 0) break
    const gapMs = gap.end.getTime() - gap.start.getTime()
    if (gapMs < MIN_CHUNK_MS) continue

    let chunkStart: Date, chunkEnd: Date, takeMs: number

    if (gap.end.getTime() <= anchorMs) {
      // Gap is BEFORE the anchor → end the chunk at gap.end.
      takeMs = Math.min(gapMs, remainingMs)
      chunkEnd = gap.end
      chunkStart = new Date(chunkEnd.getTime() - takeMs)
    } else if (gap.start.getTime() >= anchorMs) {
      // Gap is AFTER the anchor → start the chunk at gap.start.
      takeMs = Math.min(gapMs, remainingMs)
      chunkStart = gap.start
      chunkEnd = new Date(chunkStart.getTime() + takeMs)
    } else {
      // Gap CONTAINS the anchor → start the chunk at the anchor.
      const availableMs = gap.end.getTime() - anchorMs
      takeMs = Math.min(availableMs, remainingMs)
      chunkStart = anchor
      chunkEnd = new Date(chunkStart.getTime() + takeMs)
    }

    if (takeMs < MIN_CHUNK_MS) continue
    chunks.push({ start: chunkStart, end: chunkEnd })
    remainingMs -= takeMs
  }

  if (remainingMs > 0) return null
  chunks.sort((a, b) => a.start.getTime() - b.start.getTime())
  return chunks
}

function distanceFromAnchor(gap: Gap, anchorMs: number): number {
  const start = gap.start.getTime()
  const end = gap.end.getTime()
  if (anchorMs >= start && anchorMs <= end) return 0
  if (anchorMs < start) return start - anchorMs
  return anchorMs - end
}

// ---------------------------------------------------------------------------
// Service entry point — does the DB work around the pure planner above.
// ---------------------------------------------------------------------------

export async function placeTaskAtPreferred(
  taskId: string,
  preferredStart: Date,
  durationMinutes: number,
  opts: PlaceTaskOptions = {},
): Promise<PlaceTaskResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { userId: true, channelId: true },
  })
  if (!task?.userId) throw new Error('Task not found')
  const userId = task.userId

  const settings = await prisma.userSettings.findUnique({ where: { userId } })
  const gapMin = settings?.autoSchedulingGapMinutes ?? 5

  const window = await getDayWindow(userId, task.channelId, preferredStart)
  if (!window) {
    return {
      type: 'Overcommitted',
      reason: 'NO_WORKING_HOURS',
      options: ['ANOTHER_DAY', 'DEFER'],
    }
  }

  // Wipe the task's existing sessions everywhere — placeTask is the
  // "this task lives here now" semantic, same as scheduleTask. Excluding
  // them from the busy-block calculation lets us reuse their time.
  const existingSessions = await prisma.workingSession.findMany({
    where: { userId, taskId },
    select: { id: true, externalEventId: true },
  })
  const excludeIds = new Set(existingSessions.map((s) => s.id))

  const allBusy = await collectBusyBlocks(userId, preferredStart, gapMin)
  const busy = allBusy.filter(
    (b) => !(b.source === 'SESSION' && excludeIds.has(b.ref)),
  )

  const gaps = computeGaps(busy, window.start, window.end)
  if (gaps.length === 0) {
    return {
      type: 'Overcommitted',
      reason: 'NO_GAPS',
      options: ['ANOTHER_DAY', 'DEFER'],
    }
  }

  const chunks = planAroundAnchor(gaps, preferredStart, durationMinutes, opts.preventSplit ?? false)
  if (!chunks) {
    return {
      type: 'Overcommitted',
      reason: 'WOULD_NOT_FIT',
      options: ['ANOTHER_DAY', 'DEFER'],
    }
  }

  return applyPlacement(
    userId,
    taskId,
    chunks,
    Array.from(excludeIds),
    opts,
  )
}

async function applyPlacement(
  userId: string,
  taskId: string,
  chunks: Chunk[],
  oldSessionIds: string[],
  opts: PlaceTaskOptions,
): Promise<PlaceTaskResult> {
  const createdBy: 'USER' | 'SPLIT' = chunks.length === 1 ? 'USER' : 'SPLIT'

  // Single transaction: drop the task's prior sessions, insert the new chunks.
  // Doing both in one tx avoids a window where the task has 0 sessions and
  // syncTaskMirror would null its scheduledStart/End mid-flight.
  const created = await prisma.$transaction(async (tx) => {
    if (oldSessionIds.length > 0) {
      await tx.workingSession.deleteMany({ where: { id: { in: oldSessionIds } } })
    }
    const inserts: Array<{ id: string; start: Date; end: Date }> = []
    for (const c of chunks) {
      const s = await tx.workingSession.create({
        data: {
          userId,
          taskId,
          start: c.start,
          end: c.end,
          kind: 'WORK',
          createdBy,
        },
        select: { id: true, start: true, end: true },
      })
      inserts.push(s)
    }
    return inserts
  })

  // Mirror first/last onto the task row.
  await syncTaskMirror(taskId)

  const changes: CommandChange[] = created.map((s) => ({
    entity: 'WorkingSession',
    id: s.id,
    before: null,
    after: {
      id: s.id,
      userId,
      taskId,
      start: s.start,
      end: s.end,
      kind: 'WORK',
      createdBy,
    },
  }))
  const cmd = await commandManager.record({
    userId,
    type: chunks.length === 1 ? 'PLACE_TASK' : 'PLACE_TASK_SPLIT',
    changes,
    triggeredBy: opts.triggeredBy ?? 'USER_ACTION',
    idempotencyKey: opts.idempotencyKey,
    result: {
      type: 'Success',
      sessions: created.map((s) => ({ id: s.id, start: s.start, end: s.end })),
    },
  })

  // Google sync: fire-and-forget. Remove orphaned events for replaced
  // sessions, push the new ones. Failures here are logged but don't block
  // the user's drag — the local DB is already authoritative.
  for (const id of oldSessionIds) {
    removeSessionFromCalendar(id).catch((err) =>
      console.error('[PLACE_TASK] google remove failed', err),
    )
  }
  for (const s of created) {
    pushSessionToCalendar(s.id).catch((err) =>
      console.error('[PLACE_TASK] google push failed', err),
    )
  }

  return {
    type: 'Success',
    sessions: created.map((s) => ({ id: s.id, start: s.start, end: s.end })),
    commandId: cmd.id,
  }
}
