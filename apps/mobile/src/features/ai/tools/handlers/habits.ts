import { toast } from '@shared/lib/toast';
import { habitsService } from '@features/habits/services/habitsService';
import { queryKeys } from '@shared/api/queryKeys';
import type {
  CreateHabitPayload,
  UpdateHabitPayload,
} from '@features/habits/types';
import type { ToolHandler } from '../types';

type FrequencyType = 'daily' | 'week_days' | 'times_per_week';

export interface CreateHabitArgs {
  name: string;
  description?: string;
  frequencyType?: FrequencyType;
  targetFrequency?: number;
}

export interface UpdateHabitArgs {
  habitId: string;
  name?: string;
  description?: string;
  targetFrequency?: number;
  frequencyType?: FrequencyType;
  isActive?: boolean;
}

export interface LogHabitArgs {
  habitId: string;
  notes?: string;
}

export interface DeleteHabitArgs {
  habitId: string;
}

function invalidateHabitQueries(queryClient: import('@tanstack/react-query').QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.habits.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.habits.stats });
}

export const createHabitHandler: ToolHandler<CreateHabitArgs> = {
  name: 'createHabit',
  execute: async (args, { queryClient, t }) => {
    const payload: CreateHabitPayload = {
      name: args.name,
      description: args.description,
      target_frequency: args.targetFrequency ?? 1,
      frequency_type: args.frequencyType ?? 'daily',
    };
    const habit = await habitsService.createHabit(payload);
    invalidateHabitQueries(queryClient);
    toast.success(t('habitCreated', { defaultValue: 'Habit created' }));
    return { success: true, habit: { id: habit.id, name: habit.name } };
  },
};

export const updateHabitHandler: ToolHandler<UpdateHabitArgs> = {
  name: 'updateHabit',
  execute: async (args, { queryClient, t }) => {
    const patch: UpdateHabitPayload = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.description !== undefined) patch.description = args.description;
    if (args.targetFrequency !== undefined) patch.target_frequency = args.targetFrequency;
    if (args.frequencyType !== undefined) patch.frequency_type = args.frequencyType;
    if (args.isActive !== undefined) patch.is_active = args.isActive;
    const habit = await habitsService.updateHabit(args.habitId, patch);
    invalidateHabitQueries(queryClient);
    toast.success(t('habitUpdated', { defaultValue: 'Habit updated' }));
    return { success: true, habit: { id: habit.id } };
  },
};

export const logHabitHandler: ToolHandler<LogHabitArgs> = {
  name: 'logHabit',
  execute: async (args, { queryClient, t }) => {
    const today = new Date().toISOString().split('T')[0]!;
    const log = await habitsService.logHabit(args.habitId, {
      date: today,
      completed_count: 1,
      notes: args.notes,
    });
    invalidateHabitQueries(queryClient);
    toast.success(t('habitLogged', { defaultValue: 'Habit logged' }));
    return { success: true, log: { id: log.id } };
  },
};

export const deleteHabitHandler: ToolHandler<DeleteHabitArgs> = {
  name: 'deleteHabit',
  execute: async (args, { queryClient, t }) => {
    await habitsService.deleteHabit(args.habitId);
    invalidateHabitQueries(queryClient);
    toast.success(t('habitDeleted', { defaultValue: 'Habit deleted' }));
    return { success: true };
  },
};
