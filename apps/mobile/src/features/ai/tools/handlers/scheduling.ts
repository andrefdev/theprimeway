import { apiClient } from '@shared/api/client';
import { SCHEDULING } from '@shared/api/endpoints';
import { toast } from '@shared/lib/toast';
import { queryKeys } from '@shared/api/queryKeys';
import type { ToolHandler } from '../types';

export interface AutoScheduleTaskArgs {
  taskId: string;
  day: string;
  preventSplit?: boolean;
}

interface AutoScheduleResult {
  type?: string;
  sessions?: unknown;
  reason?: string;
  options?: unknown;
}

export const autoScheduleTaskHandler: ToolHandler<AutoScheduleTaskArgs> = {
  name: 'autoScheduleTask',
  execute: async (args, { queryClient, t }) => {
    const { data: response } = await apiClient.post(SCHEDULING.AUTO_SCHEDULE, {
      taskId: args.taskId,
      day: args.day,
      preventSplit: args.preventSplit,
    });
    const r = (response.data ?? response) as AutoScheduleResult;
    if (r.type === 'Success') {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
      toast.success(t('taskScheduled', { defaultValue: 'Task scheduled' }));
      return { success: true, sessions: r.sessions };
    }
    toast.error(t('taskScheduleFailed', { defaultValue: 'Could not schedule task' }));
    return { success: false, reason: r.reason, options: r.options };
  },
};
