import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { calendarApi } from './api'
import { CACHE_TIMES } from '@repo/shared/constants'
import { listOps, patchQueries, rollbackQueries, snapshotQueries } from '@/shared/lib/optimistic'

interface GoogleEventLike { id: string }
interface GoogleEventsResponse { data: GoogleEventLike[]; count: number }

export const calendarQueries = {
  all: () => ['calendar'] as const,

  accounts: () =>
    queryOptions({
      queryKey: [...calendarQueries.all(), 'accounts'],
      queryFn: () => calendarApi.listAccounts(),
      staleTime: CACHE_TIMES.standard,
    }),

  googleEvents: (params?: Record<string, string>) =>
    queryOptions({
      queryKey: [...calendarQueries.all(), 'google-events', params],
      queryFn: () => calendarApi.getGoogleEvents(params),
      staleTime: CACHE_TIMES.short,
    }),

  freeTime: (start: string, end: string) =>
    queryOptions({
      queryKey: [...calendarQueries.all(), 'free-time', start, end],
      queryFn: () => calendarApi.analyzeFreeTime(start, end),
      staleTime: CACHE_TIMES.standard,
      enabled: !!start && !!end,
    }),

  timeBlocks: (date: string) =>
    queryOptions({
      queryKey: [...calendarQueries.all(), 'time-blocks', date],
      queryFn: () => calendarApi.getTimeBlocks(date),
      staleTime: 0,
      enabled: false, // manual trigger
    }),

  smartSlots: (taskId: string, date: string) =>
    queryOptions({
      queryKey: [...calendarQueries.all(), 'smart-slots', taskId, date],
      queryFn: () => calendarApi.findSmartSlots(taskId, date),
      staleTime: 0,
      enabled: false, // manual trigger
    }),
}

export function useDeleteCalendarAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => calendarApi.deleteAccount(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: calendarQueries.all() })
    },
  })
}

export function useSyncCalendar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => calendarApi.sync(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: calendarQueries.all() })
    },
  })
}

export function useResubscribeCalendar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => calendarApi.resubscribe(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: calendarQueries.all() })
    },
  })
}

export function useUpdateCalendar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (args: {
      id: string
      body: { isSelectedForSync?: boolean; isPrimary?: boolean; color?: string }
    }) => calendarApi.updateCalendar(args.id, args.body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: calendarQueries.all() })
    },
  })
}

const googleEventsKey = () => [...calendarQueries.all(), 'google-events'] as const

export function useUpdateGoogleEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: {
      calendarId: string
      eventId: string
      body: Parameters<typeof calendarApi.updateGoogleEvent>[2]
    }) => calendarApi.updateGoogleEvent(args.calendarId, args.eventId, args.body),
    onMutate: async ({ eventId, body }) => {
      const snaps = await snapshotQueries<GoogleEventsResponse>(qc, googleEventsKey())
      patchQueries<GoogleEventsResponse>(qc, googleEventsKey(), (cur) => ({
        ...cur,
        data: listOps.patch(cur.data, eventId, body as Partial<GoogleEventLike>),
      }))
      return { snaps }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: calendarQueries.all() }),
  })
}

export function useDeleteGoogleEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { calendarId: string; eventId: string }) =>
      calendarApi.deleteGoogleEvent(args.calendarId, args.eventId),
    onMutate: async ({ eventId }) => {
      const snaps = await snapshotQueries<GoogleEventsResponse>(qc, googleEventsKey())
      patchQueries<GoogleEventsResponse>(qc, googleEventsKey(), (cur) => ({
        ...cur,
        data: listOps.remove(cur.data, eventId),
        count: Math.max(0, cur.count - 1),
      }))
      return { snaps }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: calendarQueries.all() }),
  })
}

export function useCreateTimeBlock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof calendarApi.createTimeBlock>[0]) =>
      calendarApi.createTimeBlock(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: calendarQueries.all() })
    },
  })
}

export function useConnectGoogleCalendar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (code: string) => calendarApi.connectGoogle(code),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: calendarQueries.all() })
    },
  })
}
