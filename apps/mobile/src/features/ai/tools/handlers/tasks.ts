import { toast } from '@shared/lib/toast';
import { tasksService } from '@features/tasks/services/tasksService';
import { queryKeys } from '@shared/api/queryKeys';
import type { TaskFormData } from '@features/tasks/types';
import type { ToolHandler } from '../types';

type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface CreateTaskArgs {
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: string;
  scheduledDate?: string;
}

export interface UpdateTaskArgs {
  taskId: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: string;
  scheduledDate?: string;
}

export interface CompleteTaskArgs {
  taskId: string;
}

export interface DeleteTaskArgs {
  taskId: string;
}

// Mobile's TaskFormData restricts priority to low/medium/high; the AI may
// propose 'urgent', so we map it to 'high' before sending to the form-shaped
// service. Keep this conversion narrow — anything else stays untouched.
function normalizePriority(p?: TaskPriority): 'low' | 'medium' | 'high' | undefined {
  if (!p) return undefined;
  if (p === 'urgent') return 'high';
  return p;
}

function invalidateTaskQueries(queryClient: import('@tanstack/react-query').QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.tasks.today });
  queryClient.invalidateQueries({ queryKey: queryKeys.tasks.grouped });
}

export const createTaskHandler: ToolHandler<CreateTaskArgs> = {
  name: 'createTask',
  execute: async (args, { queryClient, t }) => {
    const payload = {
      title: args.title,
      description: args.description,
      priority: normalizePriority(args.priority) ?? 'medium',
      dueDate: args.dueDate,
      scheduledDate: args.scheduledDate,
      tags: [],
      isAllDay: false,
    } as unknown as TaskFormData;
    const task = await tasksService.createTask(payload);
    invalidateTaskQueries(queryClient);
    toast.success(t('taskCreated', { defaultValue: 'Task created' }));
    return { success: true, task: { id: task.id, title: task.title } };
  },
};

export const updateTaskHandler: ToolHandler<UpdateTaskArgs> = {
  name: 'updateTask',
  execute: async (args, { queryClient, t }) => {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.priority !== undefined) patch.priority = normalizePriority(args.priority);
    if (args.dueDate !== undefined) patch.dueDate = args.dueDate;
    if (args.scheduledDate !== undefined) patch.scheduledDate = args.scheduledDate;
    const task = await tasksService.updateTask(args.taskId, patch as Partial<TaskFormData>);
    invalidateTaskQueries(queryClient);
    toast.success(t('taskUpdated', { defaultValue: 'Task updated' }));
    return { success: true, task: { id: task.id } };
  },
};

export const completeTaskHandler: ToolHandler<CompleteTaskArgs> = {
  name: 'completeTask',
  execute: async (args, { queryClient, t }) => {
    const task = await tasksService.updateTask(args.taskId, { status: 'completed' });
    invalidateTaskQueries(queryClient);
    toast.success(t('taskCompleted', { defaultValue: 'Task completed' }));
    return { success: true, task: { id: task.id, status: 'completed' } };
  },
};

export const deleteTaskHandler: ToolHandler<DeleteTaskArgs> = {
  name: 'deleteTask',
  execute: async (args, { queryClient, t }) => {
    await tasksService.deleteTask(args.taskId);
    invalidateTaskQueries(queryClient);
    toast.success(t('taskDeleted', { defaultValue: 'Task deleted' }));
    return { success: true, taskId: args.taskId };
  },
};
