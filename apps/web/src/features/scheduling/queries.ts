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
      // Cancel in-flight refetches so the optimistic patch isn't immediately
      // overwritten by a stale response.
      await qc.cancelQueries({ queryKey: schedulingKeys.sessions })
      const snaps = qc.getQueriesData<WorkingSession[]>({ queryKey: schedulingKeys.sessions })

      if (input.sessionId) {
        // Existing-session move: shift its start/end in every cache that has it.
        for (const [key, value] of snaps) {
          if (!value) continue
          qc.setQueryData<WorkingSession[]>(
            key,
            value.map((s) =>
              s.id === input.sessionId ? { ...s, start: input.start, end: input.end } : s,
            ),
          )
        }
        return { snaps, placeholderId: undefined as string | undefined }
      }

      if (input.taskId) {
        // Create-from-task: drop a temp placeholder into range caches whose
        // [from, to] window contains the new slot. Scoped insertion avoids
        // the cross-day pollution the previous version had.
        const placeholderId = `temp-${Math.random().toString(36).slice(2, 10)}`
        const startMs = new Date(input.start).getTime()
        const placeholder: WorkingSession = {
          id: placeholderId,
          userId: '',
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
        for (const [key, value] of snaps) {
          if (!value) continue
          // key shapes: ['working-sessions'] | [..., 'range', from, to] | [..., 'day', day, tz]
          const arr = key as readonly unknown[]
          const kind = arr[1]
          if (kind === 'range') {
            const from = arr[2] as string | undefined
            const to = arr[3] as string | undefined
            if (from && new Date(from).getTime() > startMs) continue
            if (to && new Date(to).getTime() < startMs) continue
          }
          qc.setQueryData<WorkingSession[]>(key, [...value, placeholder])
        }
        return { snaps, placeholderId }
      }

      return { snaps, placeholderId: undefined as string | undefined }
    },
    onSuccess: (data, _vars, ctx) => {
      // Swap the placeholder id for the real one returned by the server.
      // This keeps the calendar block stable through the round-trip — no
      // disappear-and-reappear flicker that a full invalidate would produce.
      if (ctx?.placeholderId && data?.session?.id) {
        const realId = data.session.id
        const placeholderId = ctx.placeholderId
        const all = qc.getQueriesData<WorkingSession[]>({ queryKey: schedulingKeys.sessions })
        for (const [key, value] of all) {
          if (!value) continue
          qc.setQueryData<WorkingSession[]>(
            key,
            value.map((s) => (s.id === placeholderId ? { ...s, id: realId } : s)),
          )
        }
      }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
    },
    onSettled: () => {
      // The optimistic patch (and onSuccess id-swap) already represents the
      // server truth for `sessions`; no need to refetch and risk a flicker.
      // Tasks (mirror) DO need to refresh so scheduledStart/End line up, and
      // commands feeds the undo strip. Calendar (Google events) is unaffected
      // by a session move so we leave it alone.
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: schedulingKeys.commands })
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
