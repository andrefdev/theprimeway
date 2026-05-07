/**
 * CommandManager — records scheduling operations as Command rows so they can be undone.
 *
 * Change semantics (per entity):
 *   - before=null, after={...}  → create   → undo deletes
 *   - before={...}, after=null  → delete   → undo re-creates
 *   - before={...}, after={...} → update   → undo writes `before`
 *
 * Supported entities for undo: WorkingSession, Task.
 * Changes are replayed in REVERSE order. Children commands are undone first.
 */
import { prisma } from '../../lib/prisma'
import {
  removeSessionFromCalendar,
  updateSessionOnCalendar,
} from '../calendar/session-push.service'

export interface CommandChange {
  entity: string
  id: string
  before: unknown
  after: unknown
}

export interface RecordCommandInput {
  userId: string
  type: string
  changes: CommandChange[]
  triggeredBy: 'USER_ACTION' | 'AUTO_RESCHEDULER' | 'ROLLOVER_JOB' | 'SYNC_JOB'
  parentCommandId?: string
  /**
   * Optional client-supplied UUID. When set, the unique constraint on
   * Command.idempotencyKey blocks duplicate inserts so a retried request
   * resolves to the original Command row instead of creating new state.
   */
  idempotencyKey?: string
  /**
   * Result payload (e.g. { sessions, commandId }) cached on the Command so
   * idempotent retries can replay the exact response the first call returned.
   */
  result?: unknown
}

type EntityHandler = {
  reinstate: (id: string, snapshot: any) => Promise<void>
  applyUpdate: (id: string, snapshot: any) => Promise<void>
  remove: (id: string) => Promise<void>
}

const handlers: Record<string, EntityHandler> = {
  WorkingSession: {
    async reinstate(id, snap) {
      await prisma.workingSession.upsert({
        where: { id },
        update: pickSessionUpdate(snap),
        create: {
          id,
          userId: snap.userId,
          taskId: snap.taskId ?? null,
          start: new Date(snap.start),
          end: new Date(snap.end),
          kind: snap.kind ?? 'WORK',
          createdBy: snap.createdBy ?? 'USER',
        },
      })
    },
    async applyUpdate(id, snap) {
      await prisma.workingSession.update({ where: { id }, data: pickSessionUpdate(snap) })
      updateSessionOnCalendar(id).catch((err) =>
        console.error('[UNDO] update calendar failed', err),
      )
    },
    async remove(id) {
      await removeSessionFromCalendar(id).catch((err) =>
        console.error('[UNDO] remove from calendar failed', err),
      )
      await prisma.workingSession.delete({ where: { id } }).catch(() => undefined)
    },
  },
  Task: {
    async reinstate() {
      throw new Error('Task reinstate on undo is not supported (no hard-delete in scheduler flows)')
    },
    async applyUpdate(id, snap) {
      const data: Record<string, unknown> = {}
      if (snap.status !== undefined) data.status = snap.status
      if (snap.completedAt !== undefined) data.completedAt = snap.completedAt ? new Date(snap.completedAt) : null
      if (snap.scheduledStart !== undefined) data.scheduledStart = snap.scheduledStart ? new Date(snap.scheduledStart) : null
      if (snap.scheduledEnd !== undefined) data.scheduledEnd = snap.scheduledEnd ? new Date(snap.scheduledEnd) : null
      if (snap.scheduledDate !== undefined) data.scheduledDate = snap.scheduledDate ? new Date(snap.scheduledDate) : null
      await prisma.task.update({ where: { id }, data })
    },
    async remove() {
      throw new Error('Task remove on undo is not supported')
    },
  },
}

function pickSessionUpdate(snap: any) {
  return {
    start: new Date(snap.start),
    end: new Date(snap.end),
    ...(snap.taskId !== undefined ? { taskId: snap.taskId } : {}),
    ...(snap.kind !== undefined ? { kind: snap.kind } : {}),
    ...(snap.createdBy !== undefined ? { createdBy: snap.createdBy } : {}),
  }
}

export const commandManager = {
  async record(input: RecordCommandInput) {
    return prisma.command.create({
      data: {
        userId: input.userId,
        type: input.type,
        payload: {
          changes: input.changes,
          ...(input.result !== undefined ? { result: input.result } : {}),
        } as any,
        triggeredBy: input.triggeredBy,
        parentCommandId: input.parentCommandId ?? null,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      },
    })
  },

  /**
   * Look up a previously-recorded Command by its idempotency key. Used by HTTP
   * handlers to short-circuit retries: if found, replay `payload.result`
   * instead of re-executing the operation.
   */
  async findByIdempotencyKey(userId: string, key: string) {
    return prisma.command.findFirst({
      where: { idempotencyKey: key, userId },
    })
  },

  /** Reverse a command's changes. Throws if already undone or entity unsupported. */
  async undo(commandId: string): Promise<{ undone: number }> {
    const cmd = await prisma.command.findUnique({
      where: { id: commandId },
      include: { children: true },
    })
    if (!cmd) throw new Error('Command not found')
    if (cmd.isUndone) throw new Error('Command already undone')

    // Undo children first (reverse chronological)
    const children = [...cmd.children].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    let undone = 0
    for (const child of children) {
      if (child.isUndone) continue
      const res = await commandManager.undo(child.id)
      undone += res.undone
    }

    const payload = cmd.payload as { changes?: CommandChange[] } | null
    const changes = payload?.changes ?? []

    // Replay in reverse order
    for (const change of [...changes].reverse()) {
      const handler = handlers[change.entity]
      if (!handler) throw new Error(`No undo handler for entity: ${change.entity}`)
      const before = change.before
      const after = change.after

      if (before === null && after !== null) {
        // Was a create → delete
        await handler.remove(change.id)
      } else if (before !== null && after === null) {
        // Was a delete → reinstate
        await handler.reinstate(change.id, before)
      } else if (before !== null && after !== null) {
        // Was an update → apply before
        await handler.applyUpdate(change.id, before)
      }
      undone++
    }

    await prisma.command.update({ where: { id: cmd.id }, data: { isUndone: true } })
    return { undone }
  },
}
