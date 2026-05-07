/**
 * Auto-schedule — find first available gap on a day and create WorkingSession(s).
 * If task doesn't fit in a single gap, attempt splitting across gaps.
 *
 * Spec: docs/TASK_SCHEDULER_ALGO.md §4–5.
 */
import { prisma } from '../../lib/prisma'
import { collectBusyBlocks, computeGaps, getDayWindow, dt, Gap } from './gap-finder'
import { commandManager, CommandChange } from './CommandManager'
import { pushSessionToCalendar } from '../calendar/session-push.service'
import { syncTaskMirror } from './task-mirror'
import { ymdToLocalDayUtc } from '@repo/shared/utils'

export type SchedulingResult =
  | { type: 'Success'; sessions: Array<{ id: string; start: Date; end: Date }>; commandId: string }
  | { type: 'Overcommitted'; reason: 'NO_WORKING_HOURS' | 'NO_GAPS' | 'WOULD_NOT_FIT'; options: string[] }

export interface AutoScheduleOptions {
  /** Block splitting even for >60min tasks (Shift+X). */
  preventSplit?: boolean
  /** Earliest allowed start inside the window (used by deconflict after an anchor). */
  earliestStart?: Date
  /** Reference "now" (injectable for tests). Defaults to `new Date()`. */
  now?: Date
  /** Optional parent command id when triggered inside a larger operation. */
  parentCommandId?: string
  /** Override command.triggeredBy. Default 'USER_ACTION'. */
  triggeredBy?: 'USER_ACTION' | 'AUTO_RESCHEDULER' | 'ROLLOVER_JOB' | 'SYNC_JOB'
  /** Idempotency key recorded on the Command so retries replay the same result. */
  idempotencyKey?: string
}

const MIN_CHUNK = 15

export async function autoSchedule(
  taskId: string,
  day: Date | string,
  opts: AutoScheduleOptions = {},
): Promise<SchedulingResult> {
  const task = await prisma.task.findFirst({ where: { id: taskId } })
  if (!task || !task.userId) throw new Error('Task not found')
  const userId = task.userId

  const settings = await prisma.userSettings.findUnique({ where: { userId } })
  const tz = settings?.timezone ?? 'UTC'
  const gapMin = settings?.autoSchedulingGapMinutes ?? 5
  const defaultDuration = settings?.defaultTaskDurationMinutes ?? 30
  const duration = task.plannedTimeMinutes ?? task.estimatedDurationMinutes ?? defaultDuration

  // Resolve `day` to an instant inside the user's local target day. Strings
  // ("YYYY-MM-DD") map directly to local midnight; Dates are taken as-is and
  // the gap-finder will re-extract Y-M-D in tz when computing the window.
  const dayDate = typeof day === 'string' ? ymdToLocalDayUtc(day, tz) : day

  const window = await getDayWindow(userId, task.channelId, dayDate)
  if (!window) return { type: 'Overcommitted', reason: 'NO_WORKING_HOURS', options: ['SCHEDULE_ANYWAY', 'ANOTHER_DAY', 'DEFER'] }

  const now = opts.now ?? new Date()
  const isToday = dt.startOfDay(dayDate, tz).getTime() === dt.startOfDay(now, tz).getTime()
  let windowStart = isToday && now > window.start ? now : window.start
  if (opts.earliestStart && opts.earliestStart > windowStart) windowStart = opts.earliestStart
  if (windowStart >= window.end) {
    return { type: 'Overcommitted', reason: 'NO_GAPS', options: ['SCHEDULE_ANYWAY', 'ANOTHER_DAY', 'DEFER'] }
  }

  const blocks = await collectBusyBlocks(userId, dayDate, gapMin)
  const gaps = computeGaps(blocks, windowStart, window.end)

  // Attempt 1: fits whole in one gap
  for (const g of gaps) {
    if (g.durationMinutes >= duration) {
      return writeSessions(userId, taskId, [{ start: g.start, end: dt.addMinutes(g.start, duration), createdBy: 'AUTO_SCHEDULE' }], opts)
    }
  }

  // Attempt 2: splitting
  const total = gaps.reduce((a, g) => a + g.durationMinutes, 0)
  const allowSplit = !opts.preventSplit && total >= duration && (duration > 60 || gaps.every((g) => g.durationMinutes < duration))
  if (allowSplit) {
    const split = planSplit(gaps, duration)
    if (split) {
      return writeSessions(userId, taskId, split.map((c) => ({ ...c, createdBy: 'SPLIT' })), opts)
    }
  }

  return { type: 'Overcommitted', reason: 'WOULD_NOT_FIT', options: ['SCHEDULE_ANYWAY', 'ANOTHER_DAY', 'DEFER'] }
}

/** Pure split planner. Returns chunks or null if impossible. */
export function planSplit(gaps: Gap[], totalDuration: number): Array<{ start: Date; end: Date }> | null {
  const chunks: Array<{ start: Date; end: Date }> = []
  let remaining = totalDuration

  for (const g of gaps) {
    if (remaining <= 0) break
    let size = Math.min(g.durationMinutes, remaining)
    if (size < MIN_CHUNK) continue
    // If leftover would be tiny, grow this chunk (still capped by gap size)
    if (remaining - size > 0 && remaining - size < MIN_CHUNK) {
      size = Math.min(remaining, g.durationMinutes)
    }
    chunks.push({ start: g.start, end: dt.addMinutes(g.start, size) })
    remaining -= size
  }

  if (remaining > 0) return null
  return chunks
}

async function writeSessions(
  userId: string,
  taskId: string,
  chunks: Array<{ start: Date; end: Date; createdBy: 'AUTO_SCHEDULE' | 'SPLIT' }>,
  opts: AutoScheduleOptions,
): Promise<SchedulingResult> {
  const created = await prisma.$transaction(
    chunks.map((c) =>
      prisma.workingSession.create({
        data: { userId, taskId, start: c.start, end: c.end, createdBy: c.createdBy, kind: 'WORK' },
      }),
    ),
  )
  // Mirror first/last session times onto the task so it appears on calendar views
  // that read `scheduledStart` / `scheduledEnd`.
  if (created.length > 0) await syncTaskMirror(taskId)
  const changes: CommandChange[] = created.map((s: any) => ({
    entity: 'WorkingSession',
    id: s.id,
    before: null,
    after: { id: s.id, userId, taskId, start: s.start, end: s.end, createdBy: s.createdBy, kind: s.kind },
  }))
  const sessionsResult = created.map((s: any) => ({ id: s.id, start: s.start, end: s.end }))
  const cmd = await commandManager.record({
    userId,
    type: chunks.length === 1 ? 'AUTO_SCHEDULE' : 'AUTO_SCHEDULE_SPLIT',
    changes,
    triggeredBy: opts.triggeredBy ?? 'USER_ACTION',
    parentCommandId: opts.parentCommandId,
    idempotencyKey: opts.idempotencyKey,
    result: { type: 'Success', sessions: sessionsResult },
  })

  // Fire-and-forget Google Calendar push (via Channel.timeboxToCalendarId)
  for (const s of created) {
    pushSessionToCalendar(s.id)
      .catch((err) => console.error('[AUTO_SCHEDULE] push to calendar failed', err))
  }

  return {
    type: 'Success',
    sessions: sessionsResult,
    commandId: cmd.id,
  }
}
