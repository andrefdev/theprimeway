import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import { PressableCard } from '@/shared/components/ui/pressable-card';
import { cn } from '@/shared/utils/cn';
import { Flame, Check } from 'lucide-react-native';
import { XpFloater } from '@/features/gamification/components/XpFloater';
import { XP_VALUES } from '@/features/gamification/model/constants';
import { useGamificationStore } from '@/features/gamification/stores/gamificationStore';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withSequence,
  withTiming,
  withRepeat,
  cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { HabitWithLogs } from '../types';
import { useTranslation } from '@/shared/hooks/useTranslation';

interface HabitCardProps {
  habit: HabitWithLogs;
  currentStreak?: number;
  onComplete: () => void;
  onUncomplete?: () => void;
  onPress?: () => void;
  className?: string;
}

function getStreakColor(streak: number): string {
  if (streak >= 30) return 'text-amber-500';
  if (streak >= 7) return 'text-orange-500';
  return 'text-slate-400';
}

function AnimatedStreak({ streak }: { streak: number }) {
  const pulseScale = useSharedValue(1);

  useEffect(() => {
    if (streak >= 7) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.1, { duration: 1000 }),
          withTiming(1, { duration: 1000 })
        ),
        -1,
        true
      );
    } else {
      pulseScale.value = withTiming(1, { duration: 150 });
    }

    return () => {
      cancelAnimation(pulseScale);
      pulseScale.value = 1;
    };
  }, [pulseScale, streak]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  return (
    <View className="flex-row items-center gap-1">
      <Animated.View style={iconStyle}>
        <Icon as={Flame} size={14} className={getStreakColor(streak)} />
      </Animated.View>
      <Text className={cn('text-xs font-bold', getStreakColor(streak))}>{streak}d</Text>
    </View>
  );
}

function WeekDots({ habit }: { habit: HabitWithLogs }) {
  const today = new Date();
  const dots = [];
  const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const log = habit.logs?.find((l) => l.date?.split('T')[0] === dateStr);
    const completed = (log?.completedCount ?? 0) >= (habit.targetFrequency || 1);
    const isToday = i === 0;

    dots.push(
      <View key={dateStr} className="items-center gap-1">
        <Text className="text-[9px] font-medium text-muted-foreground">{dayLabels[6 - i]}</Text>
        <View
          className={cn(
            'h-3 w-3 items-center justify-center rounded-sm',
            completed ? 'opacity-100' : 'opacity-30',
            isToday && !completed && 'border border-muted-foreground/40'
          )}
          style={{ backgroundColor: habit.color || '#6454FD' }}
        >
          {completed && <Icon as={Check} size={7} className="text-white font-bold" />}
        </View>
      </View>
    );
  }
  return <View className="flex-row items-center justify-between gap-1">{dots}</View>;
}

export function HabitCard({
  habit,
  currentStreak = 0,
  onComplete,
  onUncomplete,
  onPress,
  className,
}: HabitCardProps) {
  const { t } = useTranslation('features.habits');
  const today = new Date().toISOString().split('T')[0];
  const todayLog = habit.logs?.find((log) => log.date?.split('T')[0] === today);
  const completedToday = todayLog?.completedCount ?? 0;
  const target = habit.targetFrequency || 1;
  const isCompleted = completedToday >= target;

  const [showXp, setShowXp] = useState(false);
  const addXp = useGamificationStore((s) => s.addXp);
  const awardXpToBackend = useGamificationStore((s) => s.awardXpToBackend);
  const buttonScale = useSharedValue(1);

  const buttonAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const handleToggle = async () => {
    if (isCompleted) {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onUncomplete?.();
    } else {
      buttonScale.value = withSequence(
        withTiming(0.85, { duration: 80 }),
        withSpring(1.15, { damping: 6, stiffness: 300 }),
        withSpring(1, { damping: 10 })
      );
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onComplete();
      addXp({ type: 'habit', amount: XP_VALUES.habit });
      setShowXp(true);
      awardXpToBackend({
        source: 'habit',
        sourceId: habit.id,
        amount: XP_VALUES.habit,
        earnedDate: today,
        metadata: { habitName: habit.name },
      });
    }
  };

  return (
    <PressableCard onPress={onPress} className={className}>
      {/* Header: Title + Streak + Toggle Button */}
      <View className="flex-row items-start justify-between gap-3 mb-3">
        <View className="flex-1">
          <Text
            className={cn(
              'text-base font-semibold text-foreground',
              isCompleted && 'text-muted-foreground opacity-60'
            )}
            numberOfLines={1}
          >
            {habit.name}
          </Text>
        </View>

        {/* Streak badge */}
        {currentStreak > 0 && (
          <AnimatedStreak streak={currentStreak} />
        )}

        {/* Toggle button top-right */}
        <View className="relative">
          <XpFloater amount={XP_VALUES.habit} visible={showXp} onComplete={() => setShowXp(false)} />
          <Animated.View style={buttonAnimStyle}>
            <Pressable
              onPress={handleToggle}
              className={cn(
                'h-10 w-10 items-center justify-center rounded-full border-2',
                isCompleted ? 'border-transparent' : 'border-slate-300 dark:border-slate-600'
              )}
              style={isCompleted ? { backgroundColor: habit.color || '#6454FD' } : undefined}
              hitSlop={8}
            >
              {isCompleted ? (
                <Icon as={Check} size={18} className="text-white" />
              ) : (
                <View
                  className="h-4 w-4 rounded-full"
                  style={{ backgroundColor: (habit.color || '#6454FD') + '40' }}
                />
              )}
            </Pressable>
          </Animated.View>
        </View>
      </View>

      {/* Week dots — full width */}
      <View className="mb-2">
        <WeekDots habit={habit} />
      </View>

      {/* Progress counter if target > 1 */}
      {target > 1 && (
        <View className="flex-row items-center justify-between pt-2 border-t border-border/50">
          <Text className="text-xs text-muted-foreground">{t('dailyTarget')}</Text>
          <Text className="text-sm font-semibold" style={{ color: habit.color || '#6454FD' }}>
            {completedToday}/{target}
          </Text>
        </View>
      )}
    </PressableCard>
  );
}
