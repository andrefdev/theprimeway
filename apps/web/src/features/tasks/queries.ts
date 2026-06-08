import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { tasksApi } from './api'
import { CACHE_TIMES } from '@repo/shared/constants'
import type { Task } from '@repo/shared/types'
import type { CreateTaskInput, UpdateTaskInput } from '@repo/shared/validators'
import { listOps, patchQueries, rollbackQueries } from '@/shared/lib/optimistic'
import { playSound } from '@/shared/lib/sound'

interface TasksListResponse {
  data: Task[]
  count: number
}

interface GroupedTasksResponse {
  groups: Array<{ date_key: string; tasks: Task[] }>
  archive: Task[]
}

export const tasksQueries = {
  all: () => ['tasks'] as const,
  lists: () => [...tasksQueries.all(), 'list'] as const,

  list: (params?: Record<string, string>) =>
    queryOptions({
      queryKey: [...tasksQueries.lists(), params],
      queryFn: () => tasksApi.list(params),
      staleTime: CACHE_TIMES.standard,
    }),

  today: (referenceDate: string) =>
    queryOptions({
      queryKey: [...tasksQueries.lists(), { filter: 'today', referenceDate }],
      queryFn: () => tasksApi.list({ filter: 'today', referenceDate }),
      staleTime: CACHE_TIMES.standard,
    }),

  grouped: (params: {
    referenceDate: string
    startDate?: string
    endDate?: string
    autoArchive?: boolean
    autoArchiveDays?: number
  }) =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'grouped', params],
      queryFn: () => tasksApi.grouped(params),
      staleTime: CACHE_TIMES.standard,
    }),

  detail: (id: string) =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'detail', id],
      queryFn: () => tasksApi.get(id),
      staleTime: CACHE_TIMES.standard,
    }),

  stats: (referenceDate: string) =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'stats', referenceDate],
      queryFn: () => tasksApi.stats(referenceDate),
      staleTime: CACHE_TIMES.short,
    }),

  scheduleSuggestion: (targetDate: string, estimatedDuration: number, preferredTime?: string) =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'schedule-suggestion', targetDate, estimatedDuration, preferredTime],
      queryFn: () =>
        tasksApi.getScheduleSuggestion(
          targetDate,
          estimatedDuration,
          preferredTime as 'morning' | 'afternoon' | 'evening' | undefined,
        ),
      staleTime: 0, // Always fetch fresh for schedule suggestions
      enabled: !!targetDate && estimatedDuration > 0,
    }),

  nextTask: () =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'next'],
      queryFn: () => tasksApi.suggestNextTask(),
      staleTime: 0,
    }),

  completionImpact: (taskId: string) =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'completion-impact', taskId],
      queryFn: () => tasksApi.getCompletionImpact(taskId),
      staleTime: CACHE_TIMES.standard,
      enabled: !!taskId,
    }),

  scheduleConflicts: (date: string) =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'schedule-conflicts', date],
      queryFn: () => tasksApi.getScheduleConflicts(date),
      staleTime: CACHE_TIMES.standard,
      enabled: !!date,
    }),

  calendarView: (start: string, end: string) =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'calendar-view', start, end],
      queryFn: () => tasksApi.getCalendarView(start, end),
      staleTime: CACHE_TIMES.standard,
      enabled: !!start && !!end,
    }),

  timelineView: (start: string, end: string) =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'timeline-view', start, end],
      queryFn: () => tasksApi.getTimelineView(start, end),
      staleTime: CACHE_TIMES.standard,
      enabled: !!start && !!end,
    }),

  serverStats: (days?: number) =>
    queryOptions({
      queryKey: [...tasksQueries.all(), 'server-stats', days],
      queryFn: () => tasksApi.getServerStats(days),
      staleTime: CACHE_TIMES.standard,
    }),
}

function tempTaskId() {
  return `task-tmp-${Math.random().toString(36).slice(2, 10)}`
}

const groupedKey = [...tasksQueries.all(), 'grouped'] as const

function sortGroups(groups: GroupedTasksResponse['groups']): GroupedTasksResponse['groups'] {
  return [...groups].sort((a, b) => {
    if (a.date_key === 'no-date') return 1
    if (b.date_key === 'no-date') return -1
    return b.date_key.localeCompare(a.date_key)
  })
}

function patchGrouped(qc: QueryClient, taskId: string, patch: Partial<Task>) {
  patchQueries<GroupedTasksResponse>(qc, groupedKey, (cur) => ({
    groups: cur.groups.map((g) => ({ ...g, tasks: listOps.patch(g.tasks, taskId, patch) })),
    archive: listOps.patch(cur.archive, taskId, patch),
  }))
}

function moveArchiveToGroup(qc: QueryClient, taskId: string, patch: Partial<Task>) {
  patchQueries<GroupedTasksResponse>(qc, groupedKey, (cur) => {
    const fromArchive = cur.archive.find((t) => t.id === taskId)
    if (!fromArchive) {
      // task is already in a group — fall back to plain patch
      return {
        groups: cur.groups.map((g) => ({ ...g, tasks: listOps.patch(g.tasks, taskId, patch) })),
        archive: cur.archive,
      }
    }
    const updated = { ...fromArchive, ...patch, archivedAt: null } as Task
    const dateKey = updated.scheduledDate
      ? new Date(updated.scheduledDate).toISOString().split('T')[0]!
      : 'no-date'
    const archive = listOps.remove(cur.archive, taskId)
    const idx = cur.groups.findIndex((g) => g.date_key === dateKey)
    let groups: GroupedTasksResponse['groups']
    if (idx === -1) {
      groups = sortGroups([...cur.groups, { date_key: dateKey, tasks: [updated] }])
    } else {
      groups = cur.groups.map((g, i) =>
        i === idx ? { ...g, tasks: [...g.tasks, updated] } : g,
      )
    }
    return { groups, archive }
  })
}

function moveGroupToArchive(qc: QueryClient, taskId: string, patch: Partial<Task>) {
  patchQueries<GroupedTasksResponse>(qc, groupedKey, (cur) => {
    let moved: Task | undefined
    const groups = cur.groups.map((g) => {
      const found = g.tasks.find((t) => t.id === taskId)
      if (found) moved = { ...found, ...patch }
      return { ...g, tasks: listOps.remove(g.tasks, taskId) }
    })
    if (!moved) {
      // task isn't in a group — fall back to plain patch
      return {
        groups: cur.groups.map((g) => ({ ...g, tasks: listOps.patch(g.tasks, taskId, patch) })),
        archive: listOps.patch(cur.archive, taskId, patch),
      }
    }
    return { groups, archive: [moved, ...cur.archive] }
  })
}

function removeFromGrouped(qc: QueryClient, taskId: string) {
  patchQueries<GroupedTasksResponse>(qc, groupedKey, (cur) => ({
    groups: cur.groups.map((g) => ({ ...g, tasks: listOps.remove(g.tasks, taskId) })),
    archive: listOps.remove(cur.archive, taskId),
  }))
}

function patchTaskEverywhere(
  qc: QueryClient,
  taskId: string,
  updater: (t: Task) => Partial<Task>,
) {
  patchQueries<TasksListResponse>(qc, tasksQueries.lists(), (cur) => ({
    ...cur,
    data: cur.data.map((t) => (t.id === taskId ? { ...t, ...updater(t) } : t)),
  }))
  patchQueries<GroupedTasksResponse>(qc, groupedKey, (cur) => ({
    groups: cur.groups.map((g) => ({
      ...g,
      tasks: g.tasks.map((t) => (t.id === taskId ? { ...t, ...updater(t) } : t)),
    })),
    archive: cur.archive.map((t) => (t.id === taskId ? { ...t, ...updater(t) } : t)),
  }))
  const focusKey = ['tasks', 'focus', taskId] as const
  const focusSnap = qc.getQueryData<Task>(focusKey)
  if (focusSnap) {
    qc.setQueryData<Task>(focusKey, { ...focusSnap, ...updater(focusSnap) })
  }
}

export function useCreateTask() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (data: CreateTaskInput) => tasksApi.create(data),
    onMutate: (data) => {
      // Fire-and-forget cancel — don't block optimistic patch on it.
      qc.cancelQueries({ queryKey: tasksQueries.lists() })
      qc.cancelQueries({ queryKey: groupedKey })

      const now = new Date().toISOString()
      const optimistic: Task = {
        id: tempTaskId(),
        userId: '',
        title: data.title ?? '',
        description: data.description ?? null,
        status: 'pending' as Task['status'],
        priority: (data.priority ?? 'medium') as Task['priority'],
        dueDate: data.dueDate ?? null,
        scheduledDate: data.scheduledDate ?? null,
        scheduledStart: data.scheduledStart ?? null,
        scheduledEnd: data.scheduledEnd ?? null,
        scheduledBucket: (data.scheduledBucket ?? null) as Task['scheduledBucket'],
        channelId: data.channelId ?? null,
        estimatedDuration: data.estimatedDuration ?? null,
        completedAt: null,
        isArchived: false,
        tags: data.tags ?? [],
        actualStart: null,
        actualEnd: null,
        actualDurationSeconds: null,
        createdAt: now,
        updatedAt: now,
      }

      const snaps = patchQueries<TasksListResponse>(qc, tasksQueries.lists(), (cur) => ({
        ...cur,
        data: [...cur.data, optimistic],
        count: cur.count + 1,
      }))

      const groupedSnaps = qc.getQueriesData<GroupedTasksResponse>({ queryKey: groupedKey })
      patchQueries<GroupedTasksResponse>(qc, groupedKey, (cur) => {
        const dateKey = optimistic.scheduledDate
          ? new Date(optimistic.scheduledDate).toISOString().split('T')[0]!
          : 'no-date'
        const idx = cur.groups.findIndex((g) => g.date_key === dateKey)
        if (idx === -1) {
          return {
            groups: sortGroups([...cur.groups, { date_key: dateKey, tasks: [optimistic] }]),
            archive: cur.archive,
          }
        }
        return {
          groups: cur.groups.map((g, i) =>
            i === idx ? { ...g, tasks: [...g.tasks, optimistic] } : g,
          ),
          archive: cur.archive,
        }
      })
      return { snaps, groupedSnaps }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
      if (ctx?.groupedSnaps) rollbackQueries(qc, ctx.groupedSnaps)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: tasksQueries.all() })
      // Tasks may carry scheduledStart/End that the calendar grid renders or
      // a WorkingSession the scheduler tracks; refresh both surfaces.
      qc.invalidateQueries({ queryKey: ['calendar'] })
      qc.invalidateQueries({ queryKey: ['working-sessions'] })
    },
  })
}

export function useUpdateTask() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<UpdateTaskInput> }) =>
      tasksApi.update(id, data),
    onMutate: ({ id, data }) => {
      // Fire-and-forget cancel — don't block optimistic patch on it.
      qc.cancelQueries({ queryKey: tasksQueries.lists() })
      qc.cancelQueries({ queryKey: groupedKey })

      const snaps = patchQueries<TasksListResponse>(qc, tasksQueries.lists(), (cur) => ({
        ...cur,
        data: listOps.patch(cur.data, id, data as Partial<Task>),
      }))
      const groupedSnaps = qc.getQueriesData<GroupedTasksResponse>({ queryKey: groupedKey })
      if (data?.archivedAt === null) {
        moveArchiveToGroup(qc, id, data as Partial<Task>)
      } else if (typeof data?.archivedAt === 'string') {
        moveGroupToArchive(qc, id, data as Partial<Task>)
      } else {
        patchGrouped(qc, id, data as Partial<Task>)
      }

      const focusKey = ['tasks', 'focus', id] as const
      const focusSnap = qc.getQueryData<Task>(focusKey)
      if (focusSnap) {
        qc.setQueryData<Task>(focusKey, { ...focusSnap, ...(data as Partial<Task>) })
      }
      return { snaps, groupedSnaps, focusKey, focusSnap }
    },
    onSuccess: (_res, vars) => {
      if (vars.data?.status === 'completed') playSound('taskComplete')
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
      if (ctx?.groupedSnaps) rollbackQueries(qc, ctx.groupedSnaps)
      if (ctx?.focusSnap) qc.setQueryData(ctx.focusKey, ctx.focusSnap)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: tasksQueries.all() })
      // Tasks may carry scheduledStart/End that the calendar grid renders or
      // a WorkingSession the scheduler tracks; refresh both surfaces.
      qc.invalidateQueries({ queryKey: ['calendar'] })
      qc.invalidateQueries({ queryKey: ['working-sessions'] })
    },
  })
}

export function useDeleteTask() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => tasksApi.delete(id),
    onMutate: (id) => {
      qc.cancelQueries({ queryKey: tasksQueries.lists() })
      qc.cancelQueries({ queryKey: groupedKey })

      const snaps = patchQueries<TasksListResponse>(qc, tasksQueries.lists(), (cur) => ({
        ...cur,
        data: listOps.remove(cur.data, id),
        count: Math.max(0, cur.count - 1),
      }))
      const groupedSnaps = qc.getQueriesData<GroupedTasksResponse>({ queryKey: groupedKey })
      removeFromGrouped(qc, id)
      return { snaps, groupedSnaps }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
      if (ctx?.groupedSnaps) rollbackQueries(qc, ctx.groupedSnaps)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: tasksQueries.all() })
      // Tasks may carry scheduledStart/End that the calendar grid renders or
      // a WorkingSession the scheduler tracks; refresh both surfaces.
      qc.invalidateQueries({ queryKey: ['calendar'] })
      qc.invalidateQueries({ queryKey: ['working-sessions'] })
    },
  })
}

export function useEstimateTimebox() {
  return useMutation({
    mutationFn: ({ title, description, taskId }: { title: string; description?: string; taskId?: string }) =>
      tasksApi.estimateTimebox(title, description, taskId),
  })
}

export function useScheduleTask() {
  return useMutation({
    mutationFn: ({ taskId, duration }: { taskId: string; duration?: number }) =>
      tasksApi.scheduleTask(taskId, duration),
  })
}

export function useStartTimer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => tasksApi.startTimer(taskId),
    onMutate: (taskId) => {
      qc.cancelQueries({ queryKey: tasksQueries.lists() })
      qc.cancelQueries({ queryKey: groupedKey })

      const listSnaps = qc.getQueriesData<TasksListResponse>({ queryKey: tasksQueries.lists() })
      const groupedSnaps = qc.getQueriesData<GroupedTasksResponse>({ queryKey: groupedKey })
      const focusKey = ['tasks', 'focus', taskId] as const
      const focusSnap = qc.getQueryData<Task>(focusKey)

      const now = new Date().toISOString()
      patchTaskEverywhere(qc, taskId, () => ({
        actualStart: now,
        actualEnd: null,
        status: 'open',
      }))

      return { listSnaps, groupedSnaps, focusKey, focusSnap }
    },
    onSuccess: () => playSound('pomodoroStart'),
    onError: (_e, _v, ctx) => {
      if (ctx?.listSnaps) rollbackQueries(qc, ctx.listSnaps)
      if (ctx?.groupedSnaps) rollbackQueries(qc, ctx.groupedSnaps)
      if (ctx?.focusSnap) qc.setQueryData(ctx.focusKey, ctx.focusSnap)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: tasksQueries.all() })
      // Tasks may carry scheduledStart/End that the calendar grid renders or
      // a WorkingSession the scheduler tracks; refresh both surfaces.
      qc.invalidateQueries({ queryKey: ['calendar'] })
      qc.invalidateQueries({ queryKey: ['working-sessions'] })
    },
  })
}

export function useStopTimer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => tasksApi.stopTimer(taskId),
    onMutate: (taskId) => {
      qc.cancelQueries({ queryKey: tasksQueries.lists() })
      qc.cancelQueries({ queryKey: groupedKey })

      const listSnaps = qc.getQueriesData<TasksListResponse>({ queryKey: tasksQueries.lists() })
      const groupedSnaps = qc.getQueriesData<GroupedTasksResponse>({ queryKey: groupedKey })
      const focusKey = ['tasks', 'focus', taskId] as const
      const focusSnap = qc.getQueryData<Task>(focusKey)

      const nowIso = new Date().toISOString()
      patchTaskEverywhere(qc, taskId, (t) => {
        if (!t.actualStart) return { actualEnd: nowIso }
        const prior = t.actualDurationSeconds ?? 0
        const elapsed = Math.max(
          0,
          Math.round((Date.now() - new Date(t.actualStart).getTime()) / 1000),
        )
        return {
          actualEnd: nowIso,
          actualDurationSeconds: prior + elapsed,
        }
      })

      return { listSnaps, groupedSnaps, focusKey, focusSnap }
    },
    onSuccess: () => playSound('pomodoroEnd'),
    onError: (_e, _v, ctx) => {
      if (ctx?.listSnaps) rollbackQueries(qc, ctx.listSnaps)
      if (ctx?.groupedSnaps) rollbackQueries(qc, ctx.groupedSnaps)
      if (ctx?.focusSnap) qc.setQueryData(ctx.focusKey, ctx.focusSnap)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: tasksQueries.all() })
      // Tasks may carry scheduledStart/End that the calendar grid renders or
      // a WorkingSession the scheduler tracks; refresh both surfaces.
      qc.invalidateQueries({ queryKey: ['calendar'] })
      qc.invalidateQueries({ queryKey: ['working-sessions'] })
    },
  })
}
