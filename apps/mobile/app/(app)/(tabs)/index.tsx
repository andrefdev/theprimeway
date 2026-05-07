import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { format } from 'date-fns';
import Animated, { FadeInDown } from 'react-native-reanimated';
import {
  Bell,
  CheckSquare,
  Flame,
  MoreHorizontal,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react-native';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import { Card, CardContent } from '@/shared/components/ui/card';
import { OfflineBanner } from '@/shared/components/OfflineBanner';
import { useAuthStore } from '@/shared/stores/authStore';
import { useTranslation } from '@/shared/hooks/useTranslation';
import { useTasks } from '@features/tasks';
import { useHabits, useHabitStats } from '@features/habits';
import { useAggregatedNotifications } from '@features/notifications';
import { useGamificationStore } from '@features/gamification';
import { useWidgetSync } from '@features/widgets';

export default function ProgressScreen() {
  const user = useAuthStore((s) => s.user);
  const { t } = useTranslation('features.dashboard');
  const { t: tProgress } = useTranslation('features.progress');
  const [refreshing, setRefreshing] = useState(false);
  const todayStr = format(new Date(), 'yyyy-MM-dd');

  const { data: tasks, refetch: refetchTasks } = useTasks({ date: todayStr });
  const { data: habits, refetch: refetchHabits } = useHabits();
  const { data: habitStats, refetch: refetchHabitStats } = useHabitStats();
  const { data: notificationsData } = useAggregatedNotifications();
  const syncWithBackend = useGamificationStore((s) => s.syncWithBackend);
  const level = useGamificationStore((s) => s.level);
  const dailyXp = useGamificationStore((s) => s.dailyXp);
  const dailyGoal = useGamificationStore((s) => s.dailyGoal);
  const currentStreak = useGamificationStore((s) => s.currentStreak);
  const xpInCurrentLevel = useGamificationStore((s) => s.xpInCurrentLevel);
  const xpToNextLevel = useGamificationStore((s) => s.xpToNextLevel);

  useEffect(() => {
    syncWithBackend();
  }, [syncWithBackend]);

  useWidgetSync();

  const todayTasks = useMemo(() => (Array.isArray(tasks) ? tasks : []), [tasks]);
  const completedTasks = todayTasks.filter((task) => task.status === 'completed').length;
  const taskProgress = todayTasks.length > 0 ? completedTasks / todayTasks.length : 0;

  const stats = habitStats as any;
  const completedHabits = stats?.totalCompletedToday ?? stats?.total_completed_today ?? 0;
  const totalHabits =
    stats?.totalHabits ?? stats?.total_habits ?? (Array.isArray(habits) ? habits.length : 0);
  const habitProgress = totalHabits > 0 ? completedHabits / totalHabits : 0;
  const levelProgress = xpToNextLevel > 0 ? xpInCurrentLevel / xpToNextLevel : 0;
  const dailyXpProgress = dailyGoal > 0 ? Math.min(dailyXp / dailyGoal, 1) : 0;
  const notificationCount = notificationsData?.count ?? 0;

  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return t('greeting.morning');
    if (hour < 18) return t('greeting.afternoon');
    return t('greeting.evening');
  })();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchTasks(), refetchHabits(), refetchHabitStats(), syncWithBackend()]);
    setRefreshing(false);
  }, [refetchTasks, refetchHabits, refetchHabitStats, syncWithBackend]);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-28 pt-2"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <OfflineBanner />

        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-xs font-semibold text-muted-foreground">{greeting}</Text>
            <Text className="mt-1 text-2xl font-extrabold text-foreground">
              {user?.name?.split(' ')[0] || 'ThePrimeWay'}
            </Text>
          </View>
          <View className="flex-row gap-2">
            <HeaderIcon
              icon={Bell}
              badge={notificationCount}
              onPress={() => router.push('/(app)/notifications')}
            />
            <HeaderIcon icon={MoreHorizontal} onPress={() => router.push('/(app)/settings')} />
          </View>
        </View>

        <Animated.View entering={FadeInDown.duration(350)} className="mt-5 overflow-hidden rounded-[32px]">
          <LinearGradient
            colors={['#4257ff', '#7552f6']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            className="p-5"
          >
            <View className="flex-row items-start justify-between">
              <View className="flex-1">
                <Text className="text-sm font-medium text-white/80">{tProgress('todayState')}</Text>
                <Text className="mt-3 text-4xl font-extrabold text-white">
                  {Math.round(((taskProgress + habitProgress + dailyXpProgress) / 3) * 100)}%
                </Text>
                <Text className="mt-2 text-sm leading-5 text-white/80">
                  {tProgress('summary', {
                    completedTasks,
                    totalTasks: todayTasks.length || 0,
                    completedHabits,
                    totalHabits: totalHabits || 0,
                    dailyXp,
                  })}
                </Text>
              </View>
              <View className="rounded-2xl bg-white/18 px-3 py-2">
                <Text className="text-xs font-semibold text-white/80">{tProgress('level')}</Text>
                <Text className="text-2xl font-extrabold text-white">{level}</Text>
              </View>
            </View>
            <View className="mt-6 gap-3">
              <MetricBar label={tProgress('tasks')} value={taskProgress} />
              <MetricBar label={tProgress('habits')} value={habitProgress} />
              <MetricBar label={tProgress('dailyXp')} value={dailyXpProgress} />
            </View>
          </LinearGradient>
        </Animated.View>

        <View className="mt-5 flex-row gap-3">
          <SmallStat icon={CheckSquare} label={tProgress('tasks')} value={`${completedTasks}/${todayTasks.length || 0}`} />
          <SmallStat icon={Flame} label={tProgress('streak')} value={`${currentStreak}d`} />
        </View>

        <View className="mt-3 flex-row gap-3">
          <SmallStat icon={TrendingUp} label={tProgress('level')} value={`${Math.round(levelProgress * 100)}%`} />
          <SmallStat icon={Target} label={tProgress('habits')} value={`${completedHabits}/${totalHabits || 0}`} />
        </View>

        <Pressable onPress={() => router.push('/(app)/(tabs)/ai')}>
          <Card className="mt-5 border-primary/20">
            <CardContent className="flex-row items-center gap-3">
              <View className="h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                <Icon as={Sparkles} size={22} className="text-primary" />
              </View>
              <View className="flex-1">
                <Text className="text-base font-bold text-foreground">{tProgress('aiCtaTitle')}</Text>
                <Text className="mt-1 text-sm leading-5 text-muted-foreground">
                  {tProgress('aiCtaDescription')}
                </Text>
              </View>
            </CardContent>
          </Card>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function HeaderIcon({
  icon,
  badge,
  onPress,
}: {
  icon: typeof Bell;
  badge?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="relative h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-card"
    >
      <Icon as={icon} size={19} className="text-foreground" />
      {!!badge && (
        <View className="absolute -right-1 -top-1 h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1">
          <Text className="text-[10px] font-bold text-white">{badge > 99 ? '99+' : badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

function MetricBar({ label, value }: { label: string; value: number }) {
  return (
    <View>
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-semibold text-white/80">{label}</Text>
        <Text className="text-xs font-bold text-white">{Math.round(value * 100)}%</Text>
      </View>
      <View className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/20">
        <View className="h-full rounded-full bg-white" style={{ width: `${Math.round(value * 100)}%` }} />
      </View>
    </View>
  );
}

function SmallStat({
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
      <CardContent className="gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-2xl bg-highlight">
          <Icon as={icon} size={18} className="text-primary" />
        </View>
        <View>
          <Text className="text-xl font-extrabold text-foreground">{value}</Text>
          <Text className="mt-0.5 text-xs font-medium text-muted-foreground">{label}</Text>
        </View>
      </CardContent>
    </Card>
  );
}
