import { apiClient } from '@shared/api/client';
import { POMODORO } from '@shared/api/endpoints';
import { toast } from '@shared/lib/toast';
import type { ToolHandler } from '../types';

export interface StartPomodoroArgs {
  durationMinutes: number;
  taskId?: string;
  taskTitle?: string;
}

export const startPomodoroHandler: ToolHandler<StartPomodoroArgs> = {
  name: 'startPomodoro',
  execute: async (args, { queryClient, t }) => {
    const { data: response } = await apiClient.post(POMODORO.SESSIONS, {
      sessionType: 'work',
      durationMinutes: args.durationMinutes,
      taskId: args.taskId,
    });
    const session = (response.data ?? response) as { id?: string };
    queryClient.invalidateQueries({ queryKey: ['pomodoro'] });
    toast.success(t('pomodoroStarted', { defaultValue: 'Pomodoro started' }));
    return { success: true, session: { id: session.id } };
  },
};
