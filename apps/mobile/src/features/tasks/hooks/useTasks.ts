import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/queryKeys';
import { tasksService } from '../services/tasksService';
import { scheduleTaskReminder, cancelTaskReminder } from '@features/notifications';
import { taskToContext } from '@features/notifications';
import type { Task } from '@shared/types/models';
import type { GetTasksParams, TaskFormData } from '../types';

// ============================================================
// QUERIES
// ============================================================

export function useTasks(params?: GetTasksParams) {
  return useQuery({
    queryKey: [...queryKeys.tasks.all, params],
    queryFn: () => tasksService.getTasks(params),
  });
}

export function useTasksGrouped() {
  return useQuery({
    queryKey: queryKeys.tasks.grouped,
    queryFn: () => tasksService.getTasksGrouped(),
    staleTime: 2 * 60 * 1000, // 2 min — avoids refetch on every tab visit
  });
}

export function useTaskById(id: string) {
  return useQuery({
    queryKey: queryKeys.tasks.byId(id),
    queryFn: () => tasksService.getTaskById(id),
    enabled: !!id,
  });
}

// ============================================================
// MUTATIONS
// ============================================================

export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['tasks', 'create'],
    mutationFn: (data: TaskFormData) => tasksService.createTask(data),
    onMutate: async (newTaskData) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.all });

      // Snapshot previous
      const allTaskQueries = queryClient.getQueriesData<Task[]>({ queryKey: queryKeys.tasks.all });

      // Optimistically add a placeholder task to all matching queries
      const optimisticTask: Task = {
        id: `temp-${Date.now()}`,
        title: newTaskData.title,
        description: newTaskData.description,
        status: 'open',
        priority: newTaskData.priority || 'medium',
        dueDate: newTaskData.dueDate,
        tags: newTaskData.tags || [],
        estimatedDurationMinutes: newTaskData.estimatedDurationMinutes,
        scheduledDate: newTaskData.scheduledDate,
        scheduledStart: newTaskData.scheduledStart,
        scheduledEnd: newTaskData.scheduledEnd,
        isAllDay: newTaskData.isAllDay,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      for (const [queryKey, data] of allTaskQueries) {
        if (Array.isArray(data)) {
          queryClient.setQueryData(queryKey, [optimisticTask, ...data]);
        }
      }

      return { allTaskQueries };
    },
    onError: (_err, _vars, context) => {
      // Rollback on error
      if (context?.allTaskQueries) {
        for (const [queryKey, data] of context.allTaskQueries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSuccess: (task) => {
      // Replace optimistic data with real server data
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.grouped });

      if (task?.dueDate) {
        scheduleTaskReminder(task.id, task.title, task.dueDate, task.scheduledStart, taskToContext(task));
      }
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['tasks', 'update'],
    mutationFn: ({ id, data }: { id: string; data: Partial<TaskFormData> & { status?: string } }) =>
      tasksService.updateTask(id, data),
    onMutate: async ({ id, data }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.all });

      // Snapshot all task list queries
      const allTaskQueries = queryClient.getQueriesData<Task[]>({ queryKey: queryKeys.tasks.all });

      // Optimistically update the task in all matching queries
      for (const [queryKey, tasks] of allTaskQueries) {
        if (Array.isArray(tasks)) {
          queryClient.setQueryData(
            queryKey,
            tasks.map((task) =>
              task.id === id
                ? {
                    ...task,
                    ...data,
                    ...(data.status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
                    ...(data.status === 'open' ? { completedAt: undefined } : {}),
                    updatedAt: new Date().toISOString(),
                  }
                : task
            )
          );
        }
      }

      // Also update the individual task cache
      const previousTask = queryClient.getQueryData<Task>(queryKeys.tasks.byId(id));
      if (previousTask) {
        queryClient.setQueryData(queryKeys.tasks.byId(id), { ...previousTask, ...data });
      }

      return { allTaskQueries, previousTask };
    },
    onError: (_err, variables, context) => {
      // Rollback on error
      if (context?.allTaskQueries) {
        for (const [queryKey, data] of context.allTaskQueries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
      if (context?.previousTask) {
        queryClient.setQueryData(queryKeys.tasks.byId(variables.id), context.previousTask);
      }
    },
    onSuccess: (task, variables) => {
      // Refetch only after server confirms — prevents race condition
      // where stale data overwrites the optimistic update
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.grouped });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.byId(variables.id) });

      if (task?.dueDate) {
        scheduleTaskReminder(task.id, task.title, task.dueDate, task.scheduledStart, taskToContext(task));
      } else if (variables.data.status === 'completed') {
        cancelTaskReminder(variables.id);
      }
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['tasks', 'delete'],
    mutationFn: (id: string) => tasksService.deleteTask(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.all });

      const allTaskQueries = queryClient.getQueriesData<Task[]>({ queryKey: queryKeys.tasks.all });

      // Optimistically remove the task
      for (const [queryKey, tasks] of allTaskQueries) {
        if (Array.isArray(tasks)) {
          queryClient.setQueryData(
            queryKey,
            tasks.filter((task) => task.id !== id)
          );
        }
      }

      return { allTaskQueries };
    },
    onError: (_err, _id, context) => {
      if (context?.allTaskQueries) {
        for (const [queryKey, data] of context.allTaskQueries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.grouped });
      cancelTaskReminder(id);
    },
  });
}
