import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  schedulingApi,
  type AutoScheduleInput,
  type DeconflictInput,
  type EarlyCompleteInput,
  type MoveSessionInput,
  type TimerStartInput,
} from './api'
import { workingSessionsApi, type WorkingSession } from './working-sessions-api'
import { calendarEventsApi } from './calendar-events-api'
import { listOps, patchQueries, rollbackQueries, snapshotQueries } from '@/shared/lib/optimistic'
import { api } from '@/shared/lib/api-client'
import { endOfLocalDayUtc, ymdToLocalDayUtc } from '@repo/shared/utils'
import { useUserTimezone } from '@/features/settings/hooks/use-user-timezone'

export interface WorkingHoursOverride {
  id: string
  date: string
  startTime: string
  endTime: string
}

export const schedulingKeys = {
  commands: ['scheduling', 'commands'] as const,
  sessions: ['working-sessions'] as const,
  sessionsDay: (day: string) => ['working-sessions', 'day', day] as const,
  sessionsRange: (from: string, to: string) => ['working-sessions', 'range', from, to] as const,
  eventsRange: (from: string, to: string) => ['calendar-events', 'range', from, to] as const,
  whOverride: (date: string) => ['working-hours-override', date] as const,
}

export function useWorkingHoursOverride(date: string) {
  return useQuery({
    queryKey: schedulingKeys.whOverride(date),
    queryFn: () =>
      api
        .get<{ data: WorkingHoursOverride | null }>(`/working-hours/overrides/${date}`)
        .then((r) => r.data.data),
    staleTime: 30_000,
  })
}

export function useUpsertWorkingHoursOverride() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { date: string; startTime: string; endTime: string }) =>
      api
        .put<{ data: WorkingHoursOverride }>(`/working-hours/overrides/${input.date}`, {
          startTime: input.startTime,
          endTime: input.endTime,
        })
        .then((r) => r.data.data),
    onMutate: async (input) => {
      const key = schedulingKeys.whOverride(input.date)
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<WorkingHoursOverride | null>(key)
      qc.setQueryData<WorkingHoursOverride | null>(key, {
        id: previous?.id ?? 'optimistic',
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
      })
      return { previous }
    },
    onError: (_err, vars, ctx) => {
      qc.setQueryData(schedulingKeys.whOverride(vars.date), ctx?.previous ?? null)
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: schedulingKeys.whOverride(vars.date) })
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: schedulingKeys.sessions })
    },
  })
}

export function useDeleteWorkingHoursOverride() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (date: string) => api.delete(`/working-hours/overrides/${date}`),
    onSuccess: (_data, date) => {
      qc.invalidateQueries({ queryKey: schedulingKeys.whOverride(date) })
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: schedulingKeys.sessions })
    },
  })
}

export function useWorkingSessionsRange(from: string, to: string) {
  return useQuery({
    queryKey: schedulingKeys.sessionsRange(from, to),
    queryFn: () => workingSessionsApi.list({ from, to }),
    staleTime: 10_000,
  })
}

export function useCalendarEventsRange(from: string, to: string) {
  return useQuery({
    queryKey: schedulingKeys.eventsRange(from, to),
    queryFn: () => calendarEventsApi.list(from, to),
    staleTime: 30_000,
  })
}

export function useWorkingSessionsForDay(day: string) {
  const tz = useUserTimezone()
  return useQuery({
    queryKey: [...schedulingKeys.sessionsDay(day), tz],
    queryFn: () => {
      const anchor = ymdToLocalDayUtc(day, tz)
      return workingSessionsApi.list({
        from: anchor.toISOString(),
        to: endOfLocalDayUtc(anchor, tz).toISOString(),
      })
    },
    staleTime: 10_000,
  })
}

export function useDeleteWorkingSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => workingSessionsApi.remove(id),
    onMutate: async (id) => {
      const snaps = await snapshotQueries<WorkingSession[]>(qc, schedulingKeys.sessions)
      patchQueries<WorkingSession[]>(qc, schedulingKeys.sessions, (cur) => listOps.remove(cur, id))
      return { snaps }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: schedulingKeys.sessions })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

/**
 * UUID v4 from the Web Crypto API. Falls back to a non-crypto random hex if
 * called in an environment without `crypto.randomUUID` (older Safari, jsdom).
 * Format matches the server's IDEMPOTENCY_KEY_RE (8-128 chars, [A-Za-z0-9_-]).
 */
function newIdempotencyKey(): string {
  const c = (globalThis as any).crypto
  if (c?.randomUUID) return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function useAutoSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: AutoScheduleInput) => schedulingApi.autoSchedule(input, newIdempotencyKey()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: schedulingKeys.sessions })
      qc.invalidateQueries({ queryKey: schedulingKeys.commands })
      qc.invalidateQueries({ queryKey: ['calendar'] })
    },
  })
}

export function useMoveSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: MoveSessionInput) => schedulingApi.moveSession(input, newIdempotencyKey()),
    onMutate: async (input) => {
      const snaps = await snapshotQueries<WorkingSession[]>(qc, schedulingKeys.sessions)
      if (input.sessionId) {
        patchQueries<WorkingSession[]>(qc, schedulingKeys.sessions, (cur) =>
          listOps.patch(cur, input.sessionId!, { start: input.start, end: input.end }),
        )
      } else if (input.taskId) {
        const placeholder: WorkingSession = {
          id: `optimistic-${input.taskId}-${Date.now()}`,
          userId: 'optimistic',
          taskId: input.taskId,
          kind: 'WORK',
          start: input.start,
          end: input.end,
          externalCalendarId: null,
          externalEventId: null,
          createdBy: 'USER',
          createdAt: new Date().toISOString(),
          task: null,
        }
        patchQueries<WorkingSession[]>(qc, schedulingKeys.sessions, (cur) =>
          listOps.upsert(cur, placeholder),
        )
      }
      return { snaps }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: schedulingKeys.sessions })
      qc.invalidateQueries({ queryKey: schedulingKeys.commands })
      qc.invalidateQueries({ queryKey: ['calendar'] })
    },
  })
}

export function useDeconflict() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: DeconflictInput) => schedulingApi.deconflict(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: schedulingKeys.sessions })
      qc.invalidateQueries({ queryKey: schedulingKeys.commands })
    },
  })
}

export function useCompleteEarly() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: EarlyCompleteInput) => schedulingApi.completeEarly(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: schedulingKeys.sessions })
      qc.invalidateQueries({ queryKey: schedulingKeys.commands })
    },
  })
}

export function useTimerStart() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: TimerStartInput) => schedulingApi.timerStart(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: schedulingKeys.sessions })
      qc.invalidateQueries({ queryKey: schedulingKeys.commands })
    },
  })
}

export function useRecentCommands(limit = 20) {
  return useQuery({
    queryKey: [...schedulingKeys.commands, limit],
    queryFn: () => schedulingApi.listCommands(limit),
    staleTime: 5_000,
  })
}

export function useUndoCommand() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => schedulingApi.undoCommand(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: schedulingKeys.sessions })
      qc.invalidateQueries({ queryKey: schedulingKeys.commands })
    },
  })
}
