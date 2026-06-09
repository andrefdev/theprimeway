import { apiClient } from '@shared/api/client';
import { TASKS } from '@shared/api/endpoints';
import type { Task } from '@shared/types/models';
import type { GetTasksParams, TaskFormData, TasksGroupedResponse } from '../types';

// API responses are wrapped: { data: [...], count: N }
interface ApiListResponse<T> {
  data: T[];
  count: number;
}

interface ApiGroupedResponse {
  data: {
    groups: { date_key: string; tasks: Task[] }[];
    archive: Task[];
  };
}

export const tasksService = {
  getTasks: async (params?: GetTasksParams): Promise<Task[]> => {
    const { grouped, date, ...rest } = params ?? {};
    const url = grouped ? TASKS.GROUPED : TASKS.BASE;
    // The API filters tasks for a given day via `filter=today` + `referenceDate`.
    // There is NO `date` query param — sending it was silently ignored, so the
    // endpoint returned ALL tasks capped at the default page size (the "50/50"
    // bug). Map `date` to the supported filter instead.
    const query: Record<string, unknown> = { ...rest };
    if (date) {
      query.filter = 'today';
      query.referenceDate = date;
    }
    const { data: response } = await apiClient.get(url, { params: query });
    // API returns { data: [...], count: N } — extract the array
    const tasks = Array.isArray(response) ? response : (response?.data ?? []);
    return Array.isArray(tasks) ? tasks : [];
  },

  getTasksGrouped: async (): Promise<TasksGroupedResponse> => {
    const { data: response } = await apiClient.get(TASKS.GROUPED);
    const inner = response?.data ?? response;
    const groups = inner?.groups ?? [];
    const archive = inner?.archive ?? [];

    // Convert grouped format to the shape our hooks expect
    const result: TasksGroupedResponse = {
      overdue: [],
      today: [],
      tomorrow: [],
      upcoming: [],
      unscheduled: [],
    };

    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    for (const group of groups) {
      // After camelCase transform, date_key becomes dateKey
      const key = (group as any).dateKey ?? (group as any).date_key ?? '';
      const dateOnly = key.split('T')[0]; // Strip time component if present
      if (key === 'no-date' || dateOnly === 'no-date') {
        result.unscheduled.push(...(group.tasks ?? []));
      } else if (dateOnly < today) {
        result.overdue.push(...(group.tasks ?? []));
      } else if (dateOnly === today) {
        result.today.push(...(group.tasks ?? []));
      } else if (dateOnly === tomorrow) {
        result.tomorrow.push(...(group.tasks ?? []));
      } else {
        result.upcoming.push(...(group.tasks ?? []));
      }
    }

    return result;
  },

  getTaskById: async (id: string): Promise<Task> => {
    const { data: response } = await apiClient.get<{ data: Task }>(TASKS.BY_ID(id));
    return response.data ?? response as unknown as Task;
  },

  createTask: async (taskData: TaskFormData): Promise<Task> => {
    const { data: response } = await apiClient.post<{ data: Task }>(TASKS.BASE, taskData);
    return response.data ?? response as unknown as Task;
  },

  updateTask: async (id: string, taskData: Partial<TaskFormData> & { status?: string }): Promise<Task> => {
    const { data: response } = await apiClient.put<{ data: Task }>(TASKS.BY_ID(id), taskData);
    return response.data ?? response as unknown as Task;
  },

  deleteTask: async (id: string): Promise<void> => {
    await apiClient.delete(TASKS.BY_ID(id));
  },

  scheduleTask: async (id: string): Promise<Task> => {
    const { data: response } = await apiClient.post<{ data: Task }>(TASKS.SCHEDULE(id));
    return response.data ?? response as unknown as Task;
  },

  autoArchive: async (): Promise<{ archivedCount: number }> => {
    const { data } = await apiClient.post<{ archivedCount: number }>(TASKS.AUTO_ARCHIVE);
    return data;
  },

};
