import { apiClient } from '@shared/api/client';
import { GOALS } from '@shared/api/endpoints';
import { toast } from '@shared/lib/toast';
import type { ToolHandler } from '../types';

export type GoalLevel = 'three-year' | 'three_year' | 'annual' | 'quarterly' | 'weekly';

export interface CreateGoalArgs {
  level: GoalLevel;
  title: string;
  description?: string;
  visionId?: string;
  area?: string;
  threeYearGoalId?: string;
  annualGoalId?: string;
  targetDate?: string;
  year?: number;
  quarter?: number;
}

export interface UpdateGoalProgressArgs {
  level: 'annual' | 'quarterly';
  goalId: string;
  progress: number;
}

export interface DeleteGoalArgs {
  level: GoalLevel;
  goalId: string;
}

interface GoalLike {
  id: string;
  title?: string;
  name?: string;
  progress?: number;
}

function unwrap<T>(response: any): T {
  return response.data ?? response;
}

export const createGoalHandler: ToolHandler<CreateGoalArgs> = {
  name: 'createGoal',
  execute: async (args, { queryClient, t }) => {
    let goal: GoalLike;

    if (args.level === 'three-year' || args.level === 'three_year') {
      if (!args.visionId) throw new Error('visionId required for three-year goal');
      const { data } = await apiClient.post(GOALS.THREE_YEAR, {
        visionId: args.visionId,
        area: args.area ?? 'lifestyle',
        title: args.title,
        description: args.description,
      });
      goal = unwrap<GoalLike>(data);
    } else if (args.level === 'annual') {
      if (!args.threeYearGoalId) throw new Error('threeYearGoalId required for annual goal');
      const { data } = await apiClient.post(GOALS.ANNUAL, {
        threeYearGoalId: args.threeYearGoalId,
        title: args.title,
        description: args.description,
        targetDate: args.targetDate,
      });
      goal = unwrap<GoalLike>(data);
    } else if (args.level === 'quarterly') {
      if (!args.annualGoalId || args.year == null || args.quarter == null) {
        throw new Error('annualGoalId, year, quarter required for quarterly goal');
      }
      const { data } = await apiClient.post(GOALS.QUARTERLY, {
        annualGoalId: args.annualGoalId,
        year: args.year,
        quarter: args.quarter,
        title: args.title,
        description: args.description,
      });
      goal = unwrap<GoalLike>(data);
    } else {
      throw new Error(`Unsupported goal level: ${args.level}`);
    }

    queryClient.invalidateQueries({ queryKey: ['goals'] });
    toast.success(t('goalCreated', { defaultValue: 'Goal created' }));
    return {
      success: true,
      goal: { id: goal.id, title: goal.title ?? goal.name, level: args.level },
    };
  },
};

export const updateGoalProgressHandler: ToolHandler<UpdateGoalProgressArgs> = {
  name: 'updateGoalProgress',
  execute: async (args, { queryClient, t }) => {
    const url =
      args.level === 'quarterly'
        ? GOALS.QUARTERLY_BY_ID(args.goalId)
        : GOALS.ANNUAL_BY_ID(args.goalId);
    const { data } = await apiClient.patch(url, { progress: args.progress });
    const goal = unwrap<GoalLike>(data);
    queryClient.invalidateQueries({ queryKey: ['goals'] });
    toast.success(t('goalUpdated', { defaultValue: 'Goal updated' }));
    return {
      success: true,
      goal: { id: goal.id, progress: goal.progress, level: args.level },
    };
  },
};

export const deleteGoalHandler: ToolHandler<DeleteGoalArgs> = {
  name: 'deleteGoal',
  execute: async (args, { queryClient, t }) => {
    let url: string;
    if (args.level === 'three-year' || args.level === 'three_year') {
      url = GOALS.THREE_YEAR_BY_ID(args.goalId);
    } else if (args.level === 'annual') {
      url = GOALS.ANNUAL_BY_ID(args.goalId);
    } else if (args.level === 'quarterly') {
      url = GOALS.QUARTERLY_BY_ID(args.goalId);
    } else if (args.level === 'weekly') {
      url = GOALS.WEEKLY_BY_ID(args.goalId);
    } else {
      throw new Error(`Unknown goal level: ${args.level}`);
    }
    await apiClient.delete(url);
    queryClient.invalidateQueries({ queryKey: ['goals'] });
    toast.success(t('goalDeleted', { defaultValue: 'Goal deleted' }));
    return { success: true, level: args.level };
  },
};
