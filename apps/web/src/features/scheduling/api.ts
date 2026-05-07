import { api } from '@/shared/lib/api-client'

export type SchedulingResult =
  | {
      type: 'Success'
      sessions: Array<{ id: string; start: string; end: string }>
      commandId: string
    }
  | {
      type: 'Overcommitted'
      reason: 'NO_WORKING_HOURS' | 'NO_GAPS' | 'WOULD_NOT_FIT'
      options: string[]
    }

export interface AutoScheduleInput {
  taskId: string
  /** yyyy-mm-dd */
  day: string
  preventSplit?: boolean
}

export interface MoveSessionInput {
  /** Provide sessionId to move an existing session, or taskId to create a new one. */
  sessionId?: string
  taskId?: string
  start: string
  end: string
  /** Run deconflict cascade against overlapping sessions. Default false (UI moves are local). */
  deconflict?: boolean
}

export interface MoveSessionResult {
  session: { id: string; start: string; end: string; taskId: string | null }
  commandId: string
}

export interface PlaceSessionInput {
  taskId: string
  /** ISO datetime — anchor for the placement. */
  preferredStart: string
  /** Override the task's default duration in minutes. */
  duration?: number
  /** If true, return Overcommitted instead of splitting across busy blocks. */
  preventSplit?: boolean
}

export interface DeconflictInput {
  sessionId: string
}

export interface EarlyCompleteInput {
  taskId: string
  completedAt?: string
}

export interface TimerStartInput {
  taskId: string
  startedAt?: string
}

export interface CommandRow {
  id: string
  userId: string
  type: string
  payload: unknown
  isUndone: boolean
  triggeredBy: string
  parentCommandId: string | null
  createdAt: string
}

function idemHeaders(key?: string) {
  return key ? { 'Idempotency-Key': key } : undefined
}

export const schedulingApi = {
  autoSchedule: (input: AutoScheduleInput, idempotencyKey?: string) =>
    api
      .post<{ data: SchedulingResult }>('/scheduling/auto-schedule', input, {
        headers: idemHeaders(idempotencyKey),
      })
      .then((r) => r.data.data),

  moveSession: (input: MoveSessionInput, idempotencyKey?: string) =>
    api
      .post<{ data: MoveSessionResult }>('/scheduling/sessions/move', input, {
        headers: idemHeaders(idempotencyKey),
      })
      .then((r) => r.data.data),

  placeSession: (input: PlaceSessionInput, idempotencyKey?: string) =>
    api
      .post<{ data: SchedulingResult }>('/scheduling/sessions/place', input, {
        headers: idemHeaders(idempotencyKey),
      })
      .then((r) => r.data.data),

  deconflict: (input: DeconflictInput) =>
    api
      .post<{ data: { commandId: string; movedCount: number; orphanedCount: number } }>(
        '/scheduling/deconflict',
        input,
      )
      .then((r) => r.data.data),

  completeEarly: ({ taskId, completedAt }: EarlyCompleteInput) =>
    api
      .post<{ data: { commandId: string; truncated: boolean; shifted: number; skipped: number } | null }>(
        `/scheduling/tasks/${taskId}/complete-early`,
        completedAt ? { completedAt } : {},
      )
      .then((r) => r.data.data),

  timerStart: ({ taskId, startedAt }: TimerStartInput) =>
    api
      .post<{ data: unknown }>(
        `/scheduling/tasks/${taskId}/timer-start`,
        startedAt ? { startedAt } : {},
      )
      .then((r) => r.data.data),

  listCommands: (limit = 50) =>
    api.get<{ data: CommandRow[] }>(`/commands?limit=${limit}`).then((r) => r.data.data),

  undoCommand: (id: string) =>
    api.post<{ data: { undone: number } }>(`/commands/${id}/undo`, {}).then((r) => r.data.data),
}
