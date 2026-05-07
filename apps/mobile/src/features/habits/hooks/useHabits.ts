import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/queryKeys';
import { habitsService } from '../services/habitsService';
import {
  scheduleHabitReminder,
  cancelHabitReminder,
  getHabitReminderSettings,
} from '@features/notifications';
import { removeHabitFromStacks } from '../services/habitStacks';
import type {
  CreateHabitPayload,
  UpdateHabitPayload,
  HabitLogPayload,
  HabitWithLogs,
  HabitStats,
} from '../types';

export function useHabits() {
  return useQuery({
    queryKey: queryKeys.habits.all,
    queryFn: () => habitsService.getHabits(),
  });
}

export function useHabitStats(
  period?: 'week' | 'month' | 'quarter' | 'year',
) {
  return useQuery({
    queryKey: queryKeys.habits.stats,
    queryFn: () => habitsService.getStats(period),
  });
}

export function useCreateHabit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateHabitPayload) => habitsService.createHabit(data),
    onMutate: async (newHabitData) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.habits.all });

      const previousHabits = queryClient.getQueryData<HabitWithLogs[]>(queryKeys.habits.all);

      const optimisticHabit: HabitWithLogs = {
        id: `temp-${Date.now()}`,
        name: newHabitData.name,
        description: newHabitData.description,
        category: newHabitData.category,
        color: newHabitData.color || '#6454FD',
        targetFrequency: newHabitData.target_frequency,
        frequencyType: newHabitData.frequency_type,
        weekDays: newHabitData.week_days,
        isActive: true,
        createdAt: new Date().toISOString(),
        logs: [],
      };

      if (previousHabits) {
        queryClient.setQueryData(queryKeys.habits.all, [optimisticHabit, ...previousHabits]);
      }

      return { previousHabits };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousHabits) {
        queryClient.setQueryData(queryKeys.habits.all, context.previousHabits);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habits.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.habits.stats });
    },
  });
}

export function useUpdateHabit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateHabitPayload }) =>
      habitsService.updateHabit(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.habits.all });

      const previousHabits = queryClient.getQueryData<HabitWithLogs[]>(queryKeys.habits.all);

      if (previousHabits) {
        queryClient.setQueryData(
          queryKeys.habits.all,
          previousHabits.map((habit) =>
            habit.id === id
              ? {
                  ...habit,
                  ...(data.name !== undefined && { name: data.name }),
                  ...(data.description !== undefined && { description: data.description }),
                  ...(data.category !== undefined && { category: data.category }),
                  ...(data.color !== undefined && { color: data.color }),
                  ...(data.target_frequency !== undefined && { targetFrequency: data.target_frequency }),
                  ...(data.frequency_type !== undefined && { frequencyType: data.frequency_type }),
                  ...(data.week_days !== undefined && { weekDays: data.week_days }),
                  ...(data.is_active !== undefined && { isActive: data.is_active }),
                }
              : habit
          )
        );
      }

      return { previousHabits };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousHabits) {
        queryClient.setQueryData(queryKeys.habits.all, context.previousHabits);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habits.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.habits.stats });
    },
  });
}

export function useDeleteHabit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => habitsService.deleteHabit(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.habits.all });

      const previousHabits = queryClient.getQueryData<HabitWithLogs[]>(queryKeys.habits.all);

      if (previousHabits) {
        queryClient.setQueryData(
          queryKeys.habits.all,
          previousHabits.filter((habit) => habit.id !== id)
        );
      }

      return { previousHabits };
    },
    onError: (_err, _id, context) => {
      if (context?.previousHabits) {
        queryClient.setQueryData(queryKeys.habits.all, context.previousHabits);
      }
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habits.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.habits.stats });
      cancelHabitReminder(id);
      removeHabitFromStacks(id);
    },
  });
}

export function useLogHabit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['habits', 'log'],
    mutationFn: ({ id, data }: { id: string; data: HabitLogPayload }) =>
      habitsService.logHabit(id, data),
    onMutate: async ({ id, data }) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: queryKeys.habits.all });
      await queryClient.cancelQueries({ queryKey: queryKeys.habits.stats });

      // Snapshot habits list
      const previousHabits = queryClient.getQueryData<HabitWithLogs[]>(queryKeys.habits.all);
      const previousStats = queryClient.getQueryData(queryKeys.habits.stats);

      // Optimistically update the habit logs
      if (previousHabits) {
        queryClient.setQueryData(
          queryKeys.habits.all,
          previousHabits.map((habit) => {
            if (habit.id !== id) return habit;

            const existingLogIndex = habit.logs?.findIndex(
              (l) => l.date?.split('T')[0] === data.date
            ) ?? -1;

            const updatedLogs = [...(habit.logs || [])];

            if (existingLogIndex >= 0) {
              // Update existing log
              updatedLogs[existingLogIndex] = {
                ...updatedLogs[existingLogIndex],
                completedCount: data.completed_count,
              };
            } else {
              // Add new log
              updatedLogs.push({
                id: `temp-log-${Date.now()}`,
                habitId: id,
                date: data.date,
                completedCount: data.completed_count,
                notes: data.notes,
              });
            }

            return { ...habit, logs: updatedLogs };
          })
        );
      }

      // Optimistically update stats
      if (previousStats) {
        const s = previousStats as any;
        const prevCompleted = s?.totalCompletedToday ?? s?.total_completed_today ?? 0;
        const updatedStats = {
          ...s,
          totalCompletedToday: prevCompleted + 1,
          total_completed_today: prevCompleted + 1,
        };
        queryClient.setQueryData(queryKeys.habits.stats, updatedStats);
      }

      return { previousHabits, previousStats };
    },
    onError: (_err, _vars, context) => {
      // Rollback both habits and stats
      if (context?.previousHabits) {
        queryClient.setQueryData(queryKeys.habits.all, context.previousHabits);
      }
      if (context?.previousStats) {
        queryClient.setQueryData(queryKeys.habits.stats, context.previousStats);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habits.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.habits.stats });
    },
  });
}

/**
 * Hook to manage habit reminder scheduling.
 */
export function useHabitReminder() {
  return {
    schedule: scheduleHabitReminder,
    cancel: cancelHabitReminder,
    getSettings: getHabitReminderSettings,
  };
}
