import { ScrollView, View } from 'react-native';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import { IconCircle } from '@/shared/components/ui/icon-circle';
import { Flame, CheckSquare, TrendingUp, Calendar } from 'lucide-react-native';
import { LoadingOverlay } from '@/shared/components/feedback/LoadingOverlay';
import { EmptyState } from '@/shared/components/feedback/EmptyState';
import { useHabits, useHabitStats } from '../hooks/useHabits';
import { HabitHeatmap } from './HabitHeatmap';

export function HabitsAnalytics() {
  const { data: habits, isLoading } = useHabits();
  const { data: stats } = useHabitStats('year');

  if (isLoading) return <LoadingOverlay />;

  const list = habits ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No habits yet"
        description="Create habits to see analytics here"
      />
    );
  }

  const habitDetails = stats?.habitDetails ?? [];
  const totalCompletions = habitDetails.reduce((sum, d) => sum + (d.totalCompletions ?? 0), 0);
  const longestStreak = habitDetails.reduce((max, d) => Math.max(max, d.longestStreak ?? 0), 0);
  const activeHabits = list.length;

  return (
    <ScrollView contentContainerClassName="p-4 gap-4">
      <View className="flex-row gap-3">
        <StatCard
          icon={CheckSquare}
          color="primary"
          label="Active"
          value={String(activeHabits)}
        />
        <StatCard
          icon={Flame}
          color="warning"
          label="Best streak"
          value={`${longestStreak}d`}
        />
        <StatCard
          icon={TrendingUp}
          color="success"
          label="Done"
          value={String(totalCompletions)}
        />
      </View>

      {list.map((habit) => (
        <View
          key={habit.id}
          className="rounded-xl border border-border bg-card p-4"
        >
          <View className="mb-3 flex-row items-center gap-2">
            <Icon as={Calendar} size={14} className="text-muted-foreground" />
            <Text className="flex-1 text-sm font-semibold text-foreground">
              {habit.name}
            </Text>
            {(habit as any).currentStreak ? (
              <View className="flex-row items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5">
                <Icon as={Flame} size={10} className="text-amber-500" />
                <Text className="text-2xs font-semibold text-amber-500">
                  {(habit as any).currentStreak}d
                </Text>
              </View>
            ) : null}
          </View>
          <HabitHeatmap
            logs={habit.logs as any}
            targetFrequency={habit.targetFrequency ?? 1}
            color={(habit as any).color ?? '#6366f1'}
            weeks={53}
          />
        </View>
      ))}
    </ScrollView>
  );
}

function StatCard({
  icon,
  color,
  label,
  value,
}: {
  icon: any;
  color: 'primary' | 'warning' | 'success';
  label: string;
  value: string;
}) {
  return (
    <View className="flex-1 items-center rounded-xl border border-border bg-card py-3">
      <IconCircle icon={icon} color={color} size="sm" />
      <Text className="mt-2 text-lg font-bold text-foreground">{value}</Text>
      <Text className="text-2xs text-muted-foreground">{label}</Text>
    </View>
  );
}
