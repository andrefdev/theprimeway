import { apiClient } from '@shared/api/client';
import { BRAIN } from '@shared/api/endpoints';

export interface BrainEntryStub {
  id: string;
  status: string;
}

export const brainApi = {
  create: (content: string) =>
    apiClient
      .post<{ data: BrainEntryStub }>(BRAIN.ENTRIES, { content })
      .then((r) => r.data.data),
};
