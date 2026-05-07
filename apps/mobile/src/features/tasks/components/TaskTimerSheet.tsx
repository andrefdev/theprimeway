import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Pressable, AppState } from 'react-native';
import { FormSheet } from '@/shared/components/ui/form-sheet';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import { Play, Pause, Check, Clock } from 'lucide-react-native';
import { useUpdateTask } from '../hooks/useTasks';
import { cn } from '@/shared/utils/cn';
import type { Task } from '@shared/types/models';
import * as Haptics from 'expo-haptics';
import {
  showTaskTimerNotification,
  dismissTaskTimerNotification,
} from '@features/notifications';

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatPlanned(minutes: number | undefined): string {
  const m = minutes ?? 30;
  const h = Math.floor(m / 60);
  const mins = m % 60;
  if (h > 0) return `${h}h ${mins > 0 ? `${mins}m` : ''}`;
  return `${m}m`;
}

interface TaskTimerSheetProps {
  task: Task | null;
  isOpen: boolean;
  onClose: () => void;
}

export function TaskTimerSheet({ task, isOpen, onClose }: TaskTimerSheetProps) {
  const updateTask = useUpdateTask();

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const baseElapsedRef = useRef(0);
  const startTimestampRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Initialize elapsed from task data
  useEffect(() => {
    if (task) {
      const initial = (task as any).actualDurationSeconds ?? ((task as any).actualDurationMinutes ?? 0) * 60;
      setElapsedSeconds(initial);
      baseElapsedRef.current = initial;
      setIsPlaying(false);
    }
  }, [task?.id]);

  // Timer tick using wall-clock for accuracy (handles background throttling)
  useEffect(() => {
    if (isPlaying) {
      startTimestampRef.current = Date.now();
      intervalRef.current = setInterval(() => {
        const now = Date.now();
        const delta = Math.floor((now - startTimestampRef.current) / 1000);
        const current = baseElapsedRef.current + delta;
        setElapsedSeconds(current);

        // Update persistent notification every 5 seconds
        if (task && delta % 5 === 0) {
          showTaskTimerNotification(
            current,
            task.title,
            task.estimatedDurationMinutes
          );
        }
      }, 1000);

      // Show initial notification immediately
      if (task) {
        showTaskTimerNotification(
          baseElapsedRef.current,
          task.title,
          task.estimatedDurationMinutes
        );
      }
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      dismissTaskTimerNotification();
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying]);

  // Handle app going to background and coming back
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && isPlaying) {
        const now = Date.now();
        const delta = Math.floor((now - startTimestampRef.current) / 1000);
        setElapsedSeconds(baseElapsedRef.current + delta);
      }
    });
    return () => sub.remove();
  }, [isPlaying]);

  const toggleTimer = useCallback(() => {
    if (isPlaying) {
      // Pausing — save progress
      baseElapsedRef.current = elapsedSeconds;
      setIsPlaying(false);
      saveProgress(elapsedSeconds);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else {
      setIsPlaying(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }, [isPlaying, elapsedSeconds]);

  const saveProgress = useCallback(
    (seconds: number) => {
      if (!task) return;
      updateTask.mutate({
        id: task.id,
        data: {
          actualDurationSeconds: seconds,
          actualDurationMinutes: Math.floor(seconds / 60),
        } as any,
      });
    },
    [task, updateTask]
  );

  const handleComplete = useCallback(() => {
    if (!task) return;
    saveProgress(elapsedSeconds);
    updateTask.mutate({
      id: task.id,
      data: { status: 'completed', actualDurationSeconds: elapsedSeconds, actualDurationMinutes: Math.floor(elapsedSeconds / 60) } as any,
    });
    dismissTaskTimerNotification();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onClose();
  }, [task, elapsedSeconds, saveProgress, updateTask, onClose]);

  const handleClose = useCallback(() => {
    if (isPlaying) {
      baseElapsedRef.current = elapsedSeconds;
      setIsPlaying(false);
    }
    dismissTaskTimerNotification();
    saveProgress(elapsedSeconds);
    onClose();
  }, [isPlaying, elapsedSeconds, saveProgress, onClose]);

  if (!task) return null;

  const planned = task.estimatedDurationMinutes ?? 30;
  const plannedSeconds = planned * 60;
  const progress = plannedSeconds > 0 ? Math.min(elapsedSeconds / plannedSeconds, 1) : 0;
  const isOvertime = elapsedSeconds > plannedSeconds;

  return (
    <FormSheet isOpen={isOpen} onClose={handleClose} title={task.title} snapPoints={['55%']}>
      {/* Timer Display */}
      <View className="items-center py-4">
        {/* Elapsed */}
        <Text className={cn('text-5xl font-bold tracking-tight', isOvertime ? 'text-destructive' : 'text-foreground')}>
          {formatTime(elapsedSeconds)}
        </Text>

        {/* Planned */}
        <View className="mt-2 flex-row items-center gap-1.5">
          <Icon as={Clock} size={12} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground">
            Planned: {formatPlanned(task.estimatedDurationMinutes)}
          </Text>
        </View>

        {/* Progress bar */}
        <View className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
          <View
            className={cn('h-full rounded-full', isOvertime ? 'bg-destructive' : 'bg-primary')}
            style={{ width: `${Math.min(progress * 100, 100)}%` }}
          />
        </View>
        {isOvertime && (
          <Text className="mt-1 text-xs text-destructive">
            +{formatTime(elapsedSeconds - plannedSeconds)} overtime
          </Text>
        )}
      </View>

      {/* Controls */}
      <View className="flex-row items-center justify-center gap-8 py-4">
        {/* Play/Pause */}
        <Pressable
          onPress={toggleTimer}
          className={cn(
            'h-16 w-16 items-center justify-center rounded-full shadow-lg',
            isPlaying ? 'bg-destructive shadow-destructive/30' : 'bg-primary shadow-primary/30'
          )}
        >
          <Icon as={isPlaying ? Pause : Play} size={28} className="text-white" />
        </Pressable>
      </View>

      {/* Complete Task */}
      <Pressable
        onPress={handleComplete}
        className="flex-row items-center justify-center gap-2 rounded-xl border border-success/20 bg-success/5 py-3"
      >
        <Icon as={Check} size={16} className="text-success" />
        <Text className="text-sm font-medium text-success">Mark Complete</Text>
      </Pressable>
    </FormSheet>
  );
}
