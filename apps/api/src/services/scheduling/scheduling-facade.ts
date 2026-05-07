/**
 * SchedulingFacade — the single orchestrator for any operation that touches
 * WorkingSession + Task.scheduled* + Google Calendar.
 *
 * Every entry point (HTTP route, AI tool, drag/drop, late-timer move, early-
 * completion reflow) goes through here so that the same invariants hold:
 *
 *   1. WorkingSession is the source of truth for "when".
 *   2. Task.scheduledStart/End/Date is a mirror (min/max of the task's sessions).
 *   3. Each mutation is recorded as a Command for undo.
 *   4. Google Calendar is reconciled best-effort (push/update/remove), never
 *      blocking the local mutation.
 *   5. The sync server publishes session.* events so other clients refresh.
 *
 * Functions that already exist as standalone units (autoSchedule, deconflict,
 * onTaskCompletedEarly, onTimerStart) are used internally rather than rewritten;
 * the facade adds Task-mirror reconciliation and sync publishes around them.
 */
import { prisma } from '../../lib/prisma'
import { autoSchedule, AutoScheduleOptions, SchedulingResult } from './auto-schedule'
import { deconflict } from './deconflict'
import { onTaskCompletedEarly } from './early-completion-reflow'
import { onTimerStart } from './late-timer-detector'
import { commandManager, CommandChange } from './CommandManager'
import { calendarService } from '../calendar.service'
import { syncService } from '../sync.service'
import { withUserLock } from './user-lock'
import { syncTaskMirror } from './task-mirror'

export interface CreateSessionInput {
  userId: string
  taskId?: string | null
  start: Date
  end: Date
  kind?: 'WORK' | 'POMODORO' | 'BREAK' | 'HABIT_LOG'
  createdBy?: 'USER' | 'AUTO_SCHEDULE' | 'AUTO_RESCHEDULE' | 'SPLIT' | 'IMPORT'
}

export interface CreateOrMoveOptions {
  /** Run deconflict() against the new/moved session. Default true. */
  deconflict?: boolean
  /** Push/update on Google Calendar. Default true. */
  pushToCalendar?: boolean
  /** Idempotency key — if a Command already exists for this key, replay its result. */
  idempotencyKey?: string
}

class SchedulingFacade {
  // -------------------------------------------------------------------------
  // Task-mirror reconciliation
  // -------------------------------------------------------------------------

  /**
   * Recompute Task.scheduledStart/End/Date as the (min start, max end) of the
   * task's existing WorkingSessions. Re-exposed on the facade for convenience.
   */
  syncTaskMirror = syncTaskMirror

  // -------------------------------------------------------------------------
  // High-level operations
  // -------------------------------------------------------------------------

  /**
   * Auto-schedule a task into the next available gap on a day.
   * Mirrors first/last session onto Task.scheduled*. Pushes each created
   * session to Google Calendar (fire-and-forget). Already wired by autoSchedule.
   */
  async scheduleTask(
    taskId: string,
    day: string | Date,
    opts: AutoScheduleOptions = {},
  ): Promise<SchedulingResult> {
    // Resolve userId up-front so the advisory lock can serialize concurrent
    // scheduleTask calls of the same user (they all read gaps then write).
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { userId: true },
    })
    if (!task?.userId) throw new Error('Task not found')

    const result = await withUserLock(task.userId, () => autoSchedule(taskId, day, opts))
    if (result.type === 'Success') {
      // autoSchedule already mirrors Task and triggers pushSessionToCalendar;
      // we just publish for real-time clients.
      for (const s of result.sessions) {
        syncService.publish(task.userId, {
          type: 'session.created',
          payload: { id: s.id, taskId, start: s.start, end: s.end },
        })
      }
    }
    return result
  }

  /**
   * Create a brand-new WorkingSession at an explicit start/end (manual drop,
   * timeline click, AI tool that already picked a slot).
   * - Records a Command so undo restores prior state.
   * - Updates Task mirror.
   * - Pushes to Google (fire-and-forget) unless opts.pushToCalendar=false.
   * - Optionally runs deconflict() to push overlapping sessions later.
   */
  async createSession(
    input: CreateSessionInput,
    opts: CreateOrMoveOptions = {},
  ): Promise<{ session: { id: string; start: Date; end: Date; taskId: string | null }; commandId: string }> {
    if (input.end <= input.start) throw new Error('end must be after start')
    return withUserLock(input.userId, () => this.createSessionInner(input, opts))
  }

  private async createSessionInner(
    input: CreateSessionInput,
    opts: CreateOrMoveOptions,
  ): Promise<{ session: { id: string; start: Date; end: Date; taskId: string | null }; commandId: string }> {
    const session = await prisma.workingSession.create({
      data: {
        userId: input.userId,
        taskId: input.taskId ?? null,
        start: input.start,
        end: input.end,
        kind: input.kind ?? 'WORK',
        createdBy: input.createdBy ?? 'USER',
      },
    })

    const change: CommandChange = {
      entity: 'WorkingSession',
      id: session.id,
      before: null,
      after: {
        id: session.id,
        userId: session.userId,
        taskId: session.taskId,
        start: session.start,
        end: session.end,
        kind: session.kind,
        createdBy: session.createdBy,
      },
    }
    const sessionResult = { id: session.id, start: session.start, end: session.end, taskId: session.taskId }
    const cmd = await commandManager.record({
      userId: input.userId,
      type: 'CREATE_SESSION',
      changes: [change],
      triggeredBy: 'USER_ACTION',
      idempotencyKey: opts.idempotencyKey,
      result: { session: sessionResult },
    })

    if (input.taskId) await this.syncTaskMirror(input.taskId)

    if (opts.pushToCalendar !== false) {
      calendarService
        .pushSessionToCalendar(session.id)
        .catch((err) => console.error('[FACADE_CREATE] push to calendar failed', err))
    }

    if (opts.deconflict !== false) {
      // Best-effort: cascade-rescheduling overlapping sessions. Failures are
      // non-fatal; the new session is already authoritative.
      deconflict(session.id).catch((err) =>
        console.error('[FACADE_CREATE] deconflict failed', err),
      )
    }

    syncService.publish(input.userId, {
      type: 'session.created',
      payload: { id: session.id, taskId: session.taskId, start: session.start, end: session.end },
    })

    return { session: sessionResult, commandId: cmd.id }
  }

  /**
   * Move an existing session (drag/drop). Updates Task mirror, patches Google,
   * optionally runs deconflict for overlaps caused by the move.
   * Returns 404 if the session doesn't belong to userId or doesn't exist.
   */
  async moveSession(
    userId: string,
    sessionId: string,
    newStart: Date,
    newEnd: Date,
    opts: CreateOrMoveOptions = {},
  ): Promise<
    | { ok: true; session: { id: string; start: Date; end: Date; taskId: string | null }; commandId: string }
    | { ok: false; reason: 'not_found' | 'invalid_range' }
  > {
    if (newEnd <= newStart) return { ok: false, reason: 'invalid_range' }
    return withUserLock(userId, () => this.moveSessionInner(userId, sessionId, newStart, newEnd, opts))
  }

  private async moveSessionInner(
    userId: string,
    sessionId: string,
    newStart: Date,
    newEnd: Date,
    opts: CreateOrMoveOptions,
  ): Promise<
    | { ok: true; session: { id: string; start: Date; end: Date; taskId: string | null }; commandId: string }
    | { ok: false; reason: 'not_found' | 'invalid_range' }
  > {
    const existing = await prisma.workingSession.findFirst({
      where: { id: sessionId, userId },
    })
    if (!existing) return { ok: false, reason: 'not_found' }

    const before = {
      id: existing.id,
      userId: existing.userId,
      taskId: existing.taskId,
      start: existing.start,
      end: existing.end,
      kind: existing.kind,
      createdBy: existing.createdBy,
    }
    const updated = await prisma.workingSession.update({
      where: { id: sessionId },
      data: { start: newStart, end: newEnd },
    })
    const change: CommandChange = {
      entity: 'WorkingSession',
      id: sessionId,
      before,
      after: {
        ...before,
        start: updated.start,
        end: updated.end,
      },
    }
    const sessionResult = { id: sessionId, start: updated.start, end: updated.end, taskId: updated.taskId }
    const cmd = await commandManager.record({
      userId,
      type: 'MOVE_SESSION',
      changes: [change],
      triggeredBy: 'USER_ACTION',
      idempotencyKey: opts.idempotencyKey,
      result: { session: sessionResult },
    })

    if (existing.taskId) await this.syncTaskMirror(existing.taskId)

    if (opts.pushToCalendar !== false) {
      calendarService
        .updateSessionOnCalendar(sessionId)
        .catch((err) => console.error('[FACADE_MOVE] update calendar failed', err))
    }

    if (opts.deconflict !== false) {
      deconflict(sessionId).catch((err) =>
        console.error('[FACADE_MOVE] deconflict failed', err),
      )
    }

    syncService.publish(userId, {
      type: 'session.updated',
      payload: { id: sessionId, taskId: updated.taskId, start: updated.start, end: updated.end },
    })

    return { ok: true, session: sessionResult, commandId: cmd.id }
  }

  /**
   * Remove a session. Records Command, removes Google event, refreshes Task mirror.
   */
  async removeSession(
    userId: string,
    sessionId: string,
  ): Promise<{ ok: true; commandId: string } | { ok: false; reason: 'not_found' }> {
    const existing = await prisma.workingSession.findFirst({
      where: { id: sessionId, userId },
    })
    if (!existing) return { ok: false, reason: 'not_found' }

    const before = {
      id: existing.id,
      userId: existing.userId,
      taskId: existing.taskId,
      start: existing.start,
      end: existing.end,
      kind: existing.kind,
      createdBy: existing.createdBy,
    }

    // Best-effort: remove from Google before deleting locally so undo logic
    // doesn't have to chase a dangling externalEventId.
    await calendarService
      .removeSessionFromCalendar(sessionId)
      .catch((err) => console.error('[FACADE_REMOVE] remove from calendar failed', err))
    await prisma.workingSession.delete({ where: { id: sessionId } })

    const change: CommandChange = {
      entity: 'WorkingSession',
      id: sessionId,
      before,
      after: null,
    }
    const cmd = await commandManager.record({
      userId,
      type: 'REMOVE_SESSION',
      changes: [change],
      triggeredBy: 'USER_ACTION',
    })

    if (existing.taskId) await this.syncTaskMirror(existing.taskId)

    syncService.publish(userId, {
      type: 'session.deleted',
      payload: { id: sessionId, taskId: existing.taskId },
    })

    return { ok: true, commandId: cmd.id }
  }

  // -------------------------------------------------------------------------
  // Pass-throughs (existing engines stay where they are)
  // -------------------------------------------------------------------------

  reflowEarlyCompletion = onTaskCompletedEarly
  onTimerStart = onTimerStart
  deconflict = deconflict
}

export const schedulingFacade = new SchedulingFacade()
