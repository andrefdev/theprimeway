import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { router } from 'expo-router';
import { Sparkles, X, AlertCircle, Flame, Target, Clock, Zap } from 'lucide-react-native';
import { Text } from '@/shared/components/ui/text';
import { Card, CardContent } from '@/shared/components/ui/card';
import { Icon } from '@/shared/components/ui/icon';
import { IconCircle } from '@/shared/components/ui/icon-circle';
import { cn } from '@/shared/utils/cn';
import { useTasks, useUpdateTask } from '@features/tasks';
import { useHabits, useHabitStats, useLogHabit } from '@features/habits';
import {
  buildSuggestions,
  dismissSuggestion,
  loadDismissed,
  type Suggestion,
} from '../services/proactiveSuggestions';
import { format } from 'date-fns';

const TYPE_ICON: Record<Suggestion['type'], typeof Sparkles> = {
  streak: Flame,
  overdue: AlertCircle,
  habits_pending: Target,
  plan_day: Sparkles,
  focus: Clock,
  priority: Zap,
};

const URGENCY_COLOR: Record<Suggestion['urgency'], 'destructive' | 'primary' | 'accent'> = {
  high: 'destructive',
  medium: 'primary',
  low: 'accent',
};

export function ProactiveSuggestionsCard() {
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const { data: tasks } = useTasks({ date: todayStr });
  const { data: habits } = useHabits();
  const { data: habitStats } = useHabitStats();
  const updateTask = useUpdateTask();
  const logHabit = useLogHabit();

  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadDismissed().then(setDismissed);
  }, []);

  const habitStreaks = useMemo(() => {
    const map: Record<string, number> = {};
    const cur = habitStats?.streaks?.current ?? [];
    for (const c of cur) {
      map[c.habitId] = c.currentStreak;
    }
    return map;
  }, [habitStats]);

  const suggestions = useMemo(() => {
    const hour = new Date().getHours();
    return buildSuggestions({
      tasks: Array.isArray(tasks) ? tasks : [],
      habits: Array.isArray(habits) ? habits : [],
      habitStreaks,
      hour,
    }).filter((s) => !dismissed.has(s.id)).slice(0, 2);
  }, [tasks, habits, habitStreaks, dismissed]);

  const handleAction = useCallback((s: Suggestion) => {
    if (s.action.kind === 'navigate') {
      router.push(s.action.href as never);
    } else if (s.action.kind === 'completeTask') {
      updateTask.mutate({ id: s.action.taskId, data: { status: 'completed' } });
      handleDismiss(s.id);
    } else if (s.action.kind === 'completeHabit') {
      const habit = (habits ?? []).find((h) => h.id === (s.action as any).habitId);
      const log = habit?.logs?.find((l) => l.date?.split('T')[0] === todayStr);
      logHabit.mutate({
        id: (s.action as any).habitId,
        data: { date: todayStr, completed_count: (log?.completedCount ?? 0) + 1 },
      });
      handleDismiss(s.id);
    }
  }, [updateTask, logHabit, habits, todayStr]);

  const handleDismiss = useCallback(async (id: string) => {
    await dismissSuggestion(id);
    setDismissed((prev) => new Set([...prev, id]));
  }, []);

  if (suggestions.length === 0) return null;

  return (
    <View className="gap-3">
      {suggestions.map((s) => {
        const IconCmp = TYPE_ICON[s.type];
        const color = URGENCY_COLOR[s.urgency];
        return (
          <Animated.View key={s.id} entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
            <Card className={cn(s.urgency === 'high' && 'border-destructive/30')}>
              <CardContent className="py-4">
                <View className="flex-row items-start gap-3">
                  <IconCircle icon={IconCmp} color={color} size="md" />
                  <View className="flex-1">
                    <View className="flex-row items-start justify-between gap-2">
                      <Text className="flex-1 text-base font-semibold text-foreground">{s.title}</Text>
                      <Pressable onPress={() => handleDismiss(s.id)} hitSlop={8} className="p-1">
                        <Icon as={X} size={16} className="text-muted-foreground" />
                      </Pressable>
                    </View>
                    <Text className="mt-1 text-sm leading-5 text-muted-foreground">{s.message}</Text>
                    <Pressable
                      onPress={() => handleAction(s)}
                      className="mt-3 self-start rounded-lg bg-primary px-3 py-2 active:opacity-80"
                    >
                      <Text className="text-xs font-semibold text-primary-foreground">{s.actionLabel}</Text>
                    </Pressable>
                  </View>
                </View>
              </CardContent>
            </Card>
          </Animated.View>
        );
      })}
    </View>
  );
}
