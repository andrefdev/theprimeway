import { useCallback, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button } from '@/shared/components/ui/button';
import { PressableCard } from '@/shared/components/ui/pressable-card';
import Swipeable from 'react-native-gesture-handler/Swipeable';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import { cn } from '@/shared/utils/cn';
import { Check, Clock, Play } from 'lucide-react-native';
import { XpFloater } from '@features/gamification';
import { XP_VALUES } from '@features/gamification';
import { useGamificationStore } from '@features/gamification';
import * as Haptics from 'expo-haptics';
import type { Task, TaskPriority } from '@shared/types/models';

const PRIORITY_COLOR: Record<TaskPriority, { bg: string; text: string }> = {
  high: { bg: 'bg-red-500/20', text: 'text-red-600 dark:text-red-400' },
  medium: { bg: 'bg-amber-500/20', text: 'text-amber-600 dark:text-amber-400' },
  low: { bg: 'bg-blue-500/20', text: 'text-blue-600 dark:text-blue-400' },
};

interface TaskCardProps {
  task: Task;
  onToggleComplete?: (task: Task) => void;
  onPress?: (task: Task) => void;
  onTimer?: (task: Task) => void;
  onLongPress?: () => void;
  showTimeSlot?: boolean;
}

export function TaskCard({ task, onToggleComplete, onPress, onTimer, onLongPress, showTimeSlot }: TaskCardProps) {
  const isCompleted = task.status === 'completed';
  const [showXp, setShowXp] = useState(false);
  const addXp = useGamificationStore((s) => s.addXp);
  const awardXpToBackend = useGamificationStore((s) => s.awardXpToBackend);
  const checkScale = useSharedValue(1);
  const swipeableRef = useRef<Swipeable>(null);

  const checkAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: checkScale.value }],
  }));

  const handleToggle = useCallback(() => {
    if (!isCompleted) {
      checkScale.value = withSequence(
        withTiming(0.8, { duration: 80 }),
        withSpring(1.2, { damping: 6, stiffness: 300 }),
        withSpring(1, { damping: 10 })
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const xpAmount = XP_VALUES.task[task.priority];
      addXp({ type: 'task', amount: xpAmount });
      setShowXp(true);
      const today = new Date().toISOString().split('T')[0];
      awardXpToBackend({
        source: 'task',
        sourceId: task.id,
        amount: xpAmount,
        earnedDate: today,
        metadata: { priority: task.priority, title: task.title },
      });
    }
    onToggleComplete?.(task);
  }, [task, onToggleComplete, isCompleted, addXp]);

  const handlePress = useCallback(() => onPress?.(task), [task, onPress]);
  const handleTimer = useCallback(() => onTimer?.(task), [task, onTimer]);

  const xpAmount = XP_VALUES.task[task.priority];

  const formattedDuration =
    task.estimatedDurationMinutes != null
      ? task.estimatedDurationMinutes >= 60
        ? `${Math.floor(task.estimatedDurationMinutes / 60)}h${task.estimatedDurationMinutes % 60 ? ` ${task.estimatedDurationMinutes % 60}m` : ''}`
        : `${task.estimatedDurationMinutes}m`
      : null;

  const timeSlot = showTimeSlot && task.scheduledStart
    ? new Date(task.scheduledStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  const renderRightActions = () => (
    <View className="mb-0 ml-2 w-24 items-center justify-center rounded-2xl bg-emerald-500">
      <Icon as={Check} size={24} className="text-white" />
      <Text className="mt-1 text-xs font-semibold text-white">Complete</Text>
    </View>
  );

  const handleSwipeComplete = () => {
    swipeableRef.current?.close();
    if (!isCompleted) handleToggle();
  };

  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
      <Swipeable
        ref={swipeableRef}
        renderRightActions={isCompleted ? undefined : renderRightActions}
        onSwipeableOpen={(dir) => dir === 'right' && handleSwipeComplete()}
        overshootRight={false}
        rightThreshold={60}
      >
      <PressableCard
        onPress={handlePress}
        onLongPress={onLongPress}
        delayLongPress={250}
        className={cn('relative overflow-hidden', isCompleted && 'opacity-60')}
      >
        {/* Top row: Title + Checkbox */}
        <View className="flex-row items-start justify-between gap-3 mb-3">
          <View className="flex-1 pr-2">
            <Text
              className={cn(
                'text-base font-semibold leading-tight text-foreground',
                isCompleted && 'text-muted-foreground line-through'
              )}
              numberOfLines={2}
            >
              {task.title}
            </Text>
          </View>

          {/* Small checkbox top-right */}
          <View className="relative mt-0.5">
            <XpFloater amount={xpAmount} visible={showXp} onComplete={() => setShowXp(false)} />
            <Animated.View style={checkAnimStyle}>
              <Pressable
                onPress={handleToggle}
                className={cn(
                  'h-6 w-6 items-center justify-center rounded-lg border-2',
                  isCompleted
                    ? `bg-emerald-500 border-emerald-500`
                    : 'border-slate-300 dark:border-slate-600'
                )}
                hitSlop={8}
              >
                {isCompleted && <Icon as={Check} size={14} className="text-white" />}
              </Pressable>
            </Animated.View>
          </View>
        </View>

        {/* Metadata row: Priority + Time + Duration */}
        <View className="flex-row flex-wrap items-center gap-2 mb-3">
          {/* Priority label */}
          <View className={cn('px-2.5 py-1 rounded-lg', PRIORITY_COLOR[task.priority].bg)}>
            <Text className={cn('text-xs font-semibold capitalize', PRIORITY_COLOR[task.priority].text)}>
              {task.priority}
            </Text>
          </View>

          {/* Time slot if available */}
          {timeSlot && (
            <View className="flex-row items-center gap-1 px-2 py-1 rounded-lg bg-primary/10">
              <Icon as={Clock} size={12} className="text-primary" />
              <Text className="text-xs font-medium text-primary">{timeSlot}</Text>
            </View>
          )}

          {/* Duration if available */}
          {formattedDuration && (
            <View className="flex-row items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              <Icon as={Clock} size={12} className="text-slate-600 dark:text-slate-400" />
              <Text className="text-xs text-slate-600 dark:text-slate-400">{formattedDuration}</Text>
            </View>
          )}
        </View>

        {/* Timer button — if not completed */}
        {!isCompleted && onTimer && (
          <View className="flex-row justify-end">
            <Button
              variant="ghost"
              size="sm"
              onPress={handleTimer}
              className="h-auto gap-1.5 rounded-lg bg-primary/10 px-3 py-2 active:bg-primary/20"
              hitSlop={4}
            >
              <Icon as={Play} size={14} className="text-primary" />
              <Text className="text-xs font-medium text-primary">Start</Text>
            </Button>
          </View>
        )}
      </PressableCard>
      </Swipeable>
    </Animated.View>
  );
}
