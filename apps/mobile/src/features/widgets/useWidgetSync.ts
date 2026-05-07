import { useEffect } from 'react';
import { format } from 'date-fns';
import { useTasks } from '@features/tasks';
import { useHabits, useHabitStats, useLogHabit } from '@features/habits';
import {
  writeWidgetSnapshot,
  readPendingActions,
  clearPendingActions,
  type WidgetSnapshot,
  type WidgetTask,
  type WidgetHabit,
} from './widgetData';

export function useWidgetSync() {
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const { data: tasks } = useTasks({ date: todayStr });
  const { data: habits } = useHabits();
  const { data: habitStats } = useHabitStats();
  const logHabit = useLogHabit();

  // Write snapshot whenever source data changes
  useEffect(() => {
    const run = async () => {
    const taskList = Array.isArray(tasks) ? tasks : [];
    const habitList = Array.isArray(habits) ? habits : [];
    const s: any = habitStats;

    const widgetTasks: WidgetTask[] = taskList.slice(0, 5).map((t: any) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      completed: t.status === 'completed',
      timeSlot: t.scheduledStart
        ? new Date(t.scheduledStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : undefined,
    }));

    const streakMap: Record<string, number> = {};
    const cur = s?.streaks?.current ?? [];
    for (const c of cur) {
      const id = c.habit_id ?? c.habitId;
      const streak = c.current_streak ?? c.currentStreak ?? 0;
      if (id) streakMap[id] = streak;
    }

    const pending: WidgetHabit[] = habitList
      .map((h: any) => {
        const log = h.logs?.find((l: any) => l.date?.split('T')[0] === todayStr);
        const done = (log?.completedCount ?? 0) >= (h.targetFrequency ?? 1);
        return {
          id: h.id,
          name: h.name,
          completed: done,
          streak: streakMap[h.id] ?? 0,
        };
      })
      .filter((h) => !h.completed);

    const longestArr = s?.streaks?.longest ?? [];
    const longestStreak = longestArr[0]?.streakDays ?? longestArr[0]?.streak_days ?? 0;
    const currentStreak = Math.max(0, ...Object.values(streakMap));

    const snapshot: WidgetSnapshot = {
      updatedAt: new Date().toISOString(),
      tasks: widgetTasks,
      taskCompletedCount: taskList.filter((t: any) => t.status === 'completed').length,
      taskTotal: taskList.length,
      currentStreak,
      longestStreak,
      nextHabit: pending[0] ?? null,
      pendingHabits: pending,
    };

      await writeWidgetSnapshot(snapshot);
    };
    run();
  }, [tasks, habits, habitStats, todayStr]);

  // Drain pending actions from widget (MOB-F02 check-ins)
  useEffect(() => {
    const run = async () => {
      const actions = await readPendingActions();
      if (actions.length === 0) return;

      for (const action of actions) {
        if (action.kind === 'completeHabit') {
          const habit = (habits ?? []).find((h) => h.id === action.targetId);
          const log = habit?.logs?.find((l) => l.date?.split('T')[0] === todayStr);
          logHabit.mutate({
            id: action.targetId,
            data: { date: todayStr, completed_count: (log?.completedCount ?? 0) + 1 },
          });
        }
      }
      await clearPendingActions();
    };
    run();
  }, [habits, todayStr]);
}
