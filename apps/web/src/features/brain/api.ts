import { api } from '@/shared/lib/api-client'
import type { BrainEntry, BrainGraphResponse } from '@repo/shared/types'

export interface BrainCreateResponse {
  data: BrainEntry
}

export const brainApi = {
  list: (params: { status?: string; search?: string; limit?: number; offset?: number } = {}) =>
    api.get<{ data: BrainEntry[] }>('/brain/entries', { params }).then((r) => r.data.data),

  get: (id: string) => api.get<{ data: BrainEntry }>(`/brain/entries/${id}`).then((r) => r.data.data),

  create: (content: string) =>
    api.post<BrainCreateResponse>('/brain/entries', { content }).then((r) => r.data.data),

  userUpdate: (id: string, patch: Partial<{ userTitle: string; topics: string[]; isPinned: boolean; isArchived: boolean }>) =>
    api.put<{ data: BrainEntry }>(`/brain/entries/${id}`, patch).then((r) => r.data.data),

  delete: (id: string) => api.delete(`/brain/entries/${id}`).then((r) => r.data),

  reprocess: (id: string) =>
    api.post<{ data: BrainEntry }>(`/brain/entries/${id}/reprocess`).then((r) => r.data.data),

  applyActionItem: (entryId: string, index: number) =>
    api
      .post<{ data: { task: { id: string; title: string } } }>(`/brain/entries/${entryId}/action-items/${index}/apply`)
      .then((r) => r.data.data),

  getGraph: () => api.get<{ data: BrainGraphResponse }>('/brain/graph').then((r) => r.data.data),

  mergeConcepts: (sourceId: string, targetId: string) =>
    api
      .post<{ data: { mergedConceptId: string; targetConceptId: string } }>(
        '/brain/concepts/merge',
        { sourceId, targetId },
      )
      .then((r) => r.data.data),

  deleteConcept: (id: string) =>
    api.delete<{ data: { id: string } }>(`/brain/concepts/${id}`).then((r) => r.data.data),
}
