import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format } from 'date-fns';
import { CheckSquare, Flame, Plus } from 'lucide-react-native';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import { Card, CardContent } from '@/shared/components/ui/card';
import { PillTabs } from '@/shared/components/ui/pill-tabs';
import { useTranslation } from '@/shared/hooks/useTranslation';
import { TaskComposer } from '@features/tasks';
import { TaskCard } from '@features/tasks';
import { TaskEditSheet } from '@features/tasks';
import { TaskTimerSheet } from '@features/tasks';
import { HabitCard } from '@features/habits';
import { HabitFormSheet } from '@features/habits';
import { HabitEditSheet } from '@features/habits';
import { useTasks, useUpdateTask } from '@features/tasks';
import { useHabits, useHabitStats, useLogHabit } from '@features/habits';
import type { Task } from '@shared/types/models';
import type { HabitWithLogs } from '@features/habits';

type ManualMode = 'tasks' | 'habits';

export default function ManualScreen() {
  const { t } = useTranslation('features.manual');
  const [mode, setMode] = useState<ManualMode>('tasks');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [timerTask, setTimerTask] = useState<Task | null>(null);
  const [showHabitForm, setShowHabitForm] = useState(false);
  const [editingHabit, setEditingHabit] = useState<HabitWithLogs | null>(null);

  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const { data: tasks, refetch: refetchTasks, isRefetching: tasksRefreshing } = useTasks({ date: todayStr });
  const { data: habits, refetch: refetchHabits, isRefetching: habitsRefreshing } = useHabits();
  const { data: habitStats } = useHabitStats();
  const updateTask = useUpdateTask();
  const logHabit = useLogHabit();

  const todayTasks = useMemo(() => (Array.isArray(tasks) ? tasks : []), [tasks]);
  const activeHabits = useMemo(() => (Array.isArray(habits) ? habits : []), [habits]);
  const completedTasks = todayTasks.filter((task) => task.status === 'completed').length;
  const stats = habitStats as any;
  const completedHabits = stats?.totalCompletedToday ?? stats?.total_completed_today ?? 0;
  const tabs = useMemo(
    () => [
      { key: 'tasks', label: t('tabs.tasks') },
      { key: 'habits', label: t('tabs.habits') },
    ],
    [t]
  );

  const handleToggleTask = useCallback(
    (task: Task) => {
      updateTask.mutate({
        id: task.id,
        data: { status: task.status === 'completed' ? 'open' : 'completed' },
      });
    },
    [updateTask]
  );

  const handleCompleteHabit = useCallback(
    (habit: HabitWithLogs) => {
      const today = new Date().toISOString().split('T')[0];
      const todayLog = habit.logs?.find((log) => log.date?.split('T')[0] === today);
      logHabit.mutate({
        id: habit.id,
        data: { date: today, completed_count: (todayLog?.completedCount ?? 0) + 1 },
      });
    },
    [logHabit]
  );

  const handleUncompleteHabit = useCallback(
    (habit: HabitWithLogs) => {
      const today = new Date().toISOString().split('T')[0];
      const todayLog = habit.logs?.find((log) => log.date?.split('T')[0] === today);
      const currentCount = todayLog?.completedCount ?? 0;
      if (currentCount <= 0) return;
      logHabit.mutate({
        id: habit.id,
        data: { date: today, completed_count: currentCount - 1 },
      });
    },
    [logHabit]
  );

  const getStreakForHabit = useCallback(
    (habitId: string) => {
      const details = (habitStats as any)?.habitDetails ?? (habitStats as any)?.habit_details;
      if (!Array.isArray(details)) return 0;
      const detail = details.find((item: any) => (item.habitId ?? item.habit_id) === habitId);
      return detail?.currentStreak ?? detail?.current_streak ?? 0;
    },
    [habitStats]
  );

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="px-5 pt-2">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-xs font-semibold text-muted-foreground">{t('eyebrow')}</Text>
            <Text className="mt-1 text-2xl font-extrabold text-foreground">{t('title')}</Text>
          </View>
          <Pressable
            onPress={() => (mode === 'tasks' ? undefined : setShowHabitForm(true))}
            className="h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-card"
          >
            <Icon as={Plus} size={19} className="text-foreground" />
          </Pressable>
        </View>

        <View className="mt-5">
          <PillTabs tabs={tabs} activeKey={mode} onTabPress={(key) => setMode(key as ManualMode)} />
        </View>
      </View>

      {mode === 'tasks' ? (
        <View className="flex-1 px-5 pt-4">
          <TaskComposer placeholder={t('tasks.placeholder')} />
          <View className="mt-4 flex-row gap-3">
            <SummaryCard icon={CheckSquare} label={t('tasks.completed')} value={`${completedTasks}/${todayTasks.length || 0}`} />
            <SummaryCard icon={Plus} label={t('tasks.open')} value={`${Math.max(todayTasks.length - completedTasks, 0)}`} />
          </View>
          <FlatList
            data={todayTasks}
            keyExtractor={(item) => item.id}
            className="mt-4"
            contentContainerClassName="gap-3 pb-28"
            refreshControl={<RefreshControl refreshing={tasksRefreshing} onRefresh={refetchTasks} />}
            renderItem={({ item }) => (
              <TaskCard
                task={item}
                onToggleComplete={handleToggleTask}
                onPress={() => setEditingTask(item)}
                onTimer={() => setTimerTask(item)}
                showTimeSlot
              />
            )}
            ListEmptyComponent={
              <EmptyManualState icon={CheckSquare} title={t('tasks.emptyTitle')} description={t('tasks.emptyDescription')} />
            }
          />
        </View>
      ) : (
        <ScrollView
          className="flex-1 px-5 pt-4"
          contentContainerClassName="pb-28"
          refreshControl={<RefreshControl refreshing={habitsRefreshing} onRefresh={refetchHabits} />}
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            onPress={() => setShowHabitForm(true)}
            className="flex-row items-center justify-between rounded-3xl bg-primary px-5 py-4 shadow-sm shadow-primary/20"
          >
            <View>
              <Text className="text-sm font-semibold text-primary-foreground/80">{t('habits.newEyebrow')}</Text>
              <Text className="mt-1 text-lg font-extrabold text-primary-foreground">{t('habits.create')}</Text>
            </View>
            <View className="h-11 w-11 items-center justify-center rounded-2xl bg-white/20">
              <Icon as={Plus} size={20} className="text-primary-foreground" />
            </View>
          </Pressable>

          <View className="mt-4 flex-row gap-3">
            <SummaryCard icon={Flame} label={t('habits.doneToday')} value={`${completedHabits}`} />
            <SummaryCard icon={CheckSquare} label={t('habits.active')} value={`${activeHabits.length}`} />
          </View>

          <View className="mt-4 gap-3">
            {activeHabits.length > 0 ? (
              activeHabits.map((habit) => (
                <HabitCard
                  key={habit.id}
                  habit={habit}
                  currentStreak={getStreakForHabit(habit.id)}
                  onComplete={() => handleCompleteHabit(habit)}
                  onUncomplete={() => handleUncompleteHabit(habit)}
                  onPress={() => setEditingHabit(habit)}
                />
              ))
            ) : (
              <EmptyManualState icon={Flame} title={t('habits.emptyTitle')} description={t('habits.emptyDescription')} />
            )}
          </View>
        </ScrollView>
      )}

      <TaskEditSheet task={editingTask} isOpen={!!editingTask} onClose={() => setEditingTask(null)} />
      <TaskTimerSheet task={timerTask} isOpen={!!timerTask} onClose={() => setTimerTask(null)} />
      <HabitFormSheet isOpen={showHabitForm} onClose={() => setShowHabitForm(false)} />
      <HabitEditSheet habit={editingHabit} isOpen={!!editingHabit} onClose={() => setEditingHabit(null)} />
    </SafeAreaView>
  );
}

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: typeof CheckSquare;
  label: string;
  value: string;
}) {
  return (
    <Card className="flex-1 py-4">
      <CardContent className="gap-2">
        <Icon as={icon} size={18} className="text-primary" />
        <Text className="text-xl font-extrabold text-foreground">{value}</Text>
        <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
      </CardContent>
    </Card>
  );
}

function EmptyManualState({
  icon,
  title,
  description,
}: {
  icon: typeof CheckSquare;
  title: string;
  description: string;
}) {
  return (
    <Card className="mt-2">
      <CardContent className="items-center py-8">
        <View className="h-14 w-14 items-center justify-center rounded-3xl bg-highlight">
          <Icon as={icon} size={24} className="text-primary" />
        </View>
        <Text className="mt-4 text-base font-bold text-foreground">{title}</Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">{description}</Text>
      </CardContent>
    </Card>
  );
}
