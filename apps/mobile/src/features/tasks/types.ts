export type { Task, TaskStatus, TaskPriority, TaskSource } from '@shared/types/models';

// Form schema lives in @shared/types/forms (UI-only, mobile-specific shape).
// Re-export so consumers can keep importing from @features/tasks.
export { taskFormSchema, type TaskFormData } from '@shared/types/forms';

// API request/response shapes — sourced from @repo/shared (single source of truth).
export type { GetTasksParams, TasksGroupedResponse } from '@repo/shared/types';
