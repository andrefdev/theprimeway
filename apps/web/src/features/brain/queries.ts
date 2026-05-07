import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { brainApi } from './api'
import type { BrainEntry } from '@repo/shared/types'
import { listOps, patchQueries, rollbackQueries, snapshotQueries } from '@/shared/lib/optimistic'

const ACTIVE_STATUSES = new Set(['pending', 'transcribing', 'analyzing'])

export const brainKeys = {
  feeds: () => ['brain', 'feed'] as const,
  feed: (params: { status?: string; search?: string } = {}) => [...brainKeys.feeds(), params] as const,
  entry: (id: string) => ['brain', 'entry', id] as const,
  graph: () => ['brain', 'graph'] as const,
}

function tempBrainId() {
  return `brain-tmp-${Math.random().toString(36).slice(2, 10)}`
}

export function useBrainFeed(params: { status?: string; search?: string } = {}) {
  return useQuery({
    queryKey: brainKeys.feed(params),
    queryFn: () => brainApi.list(params),
    staleTime: 10_000,
    // Keep feed fresh while any entry is still processing.
    refetchInterval: (q) => {
      const data = q.state.data as BrainEntry[] | undefined
      return data?.some((e) => ACTIVE_STATUSES.has(e.status)) ? 3000 : false
    },
  })
}

export function useBrainGraph(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: brainKeys.graph(),
    queryFn: () => brainApi.getGraph(),
    staleTime: 5 * 60_000,
    enabled: opts.enabled ?? true,
  })
}

export function useBrainEntry(id: string | null | undefined) {
  return useQuery({
    queryKey: id ? brainKeys.entry(id) : ['brain', 'entry', 'none'],
    queryFn: () => brainApi.get(id!),
    enabled: !!id,
    refetchInterval: (q) => {
      const data = q.state.data as BrainEntry | undefined
      return data && ACTIVE_STATUSES.has(data.status) ? 2000 : false
    },
  })
}

export function useCreateBrainEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (content: string) => brainApi.create(content),
    onMutate: async (content) => {
      const snaps = await snapshotQueries<BrainEntry[]>(qc, brainKeys.feeds())
      const now = new Date().toISOString()
      const optimistic = {
        id: tempBrainId(),
        content,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      } as unknown as BrainEntry
      patchQueries<BrainEntry[]>(qc, brainKeys.feeds(), (cur) => [optimistic, ...cur])
      return { snaps }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: brainKeys.feeds() }),
  })
}

export function useMergeConcepts() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: string; targetId: string }) =>
      brainApi.mergeConcepts(sourceId, targetId),
    onSuccess: () => qc.invalidateQueries({ queryKey: brainKeys.graph() }),
  })
}

export function useDeleteConcept() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => brainApi.deleteConcept(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: brainKeys.graph() }),
  })
}

export function useReprocessBrainEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => brainApi.reprocess(id),
    onSuccess: (entry) => {
      qc.invalidateQueries({ queryKey: brainKeys.feeds() })
      qc.invalidateQueries({ queryKey: brainKeys.entry(entry.id) })
      // Reprocess clears old occurrences and re-extracts concepts — graph
      // shape can change, so refresh it.
      qc.invalidateQueries({ queryKey: brainKeys.graph() })
    },
  })
}

export function useDeleteBrainEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => brainApi.delete(id),
    onMutate: async (id) => {
      const snaps = await snapshotQueries<BrainEntry[]>(qc, brainKeys.feeds())
      patchQueries<BrainEntry[]>(qc, brainKeys.feeds(), (cur) => listOps.remove(cur, id))
      return { snaps }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snaps) rollbackQueries(qc, ctx.snaps)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: brainKeys.feeds() })
      // Deleting an entry may orphan its concepts (server soft-deletes them),
      // so the cached graph view is now stale.
      qc.invalidateQueries({ queryKey: brainKeys.graph() })
    },
  })
}

export function useApplyActionItem(entryId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (index: number) => brainApi.applyActionItem(entryId, index),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: brainKeys.entry(entryId) })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export function useUpdateBrainEntry(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<{ userTitle: string; topics: string[]; isPinned: boolean; isArchived: boolean }>) =>
      brainApi.userUpdate(id, patch),
    onMutate: async (patch) => {
      const feedSnaps = await snapshotQueries<BrainEntry[]>(qc, brainKeys.feeds())
      const entrySnaps = await snapshotQueries<BrainEntry>(qc, brainKeys.entry(id))
      patchQueries<BrainEntry[]>(qc, brainKeys.feeds(), (cur) =>
        listOps.patch(cur, id, patch as Partial<BrainEntry>),
      )
      patchQueries<BrainEntry>(qc, brainKeys.entry(id), (cur) => ({ ...cur, ...(patch as Partial<BrainEntry>) }))
      return { feedSnaps, entrySnaps }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.feedSnaps) rollbackQueries(qc, ctx.feedSnaps)
      if (ctx?.entrySnaps) rollbackQueries(qc, ctx.entrySnaps)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: brainKeys.entry(id) })
      qc.invalidateQueries({ queryKey: brainKeys.feeds() })
    },
  })
}
