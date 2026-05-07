import AsyncStorage from '@react-native-async-storage/async-storage';
import { format } from 'date-fns';
import type { Task } from '@shared/types/models';
import type { HabitWithLogs } from '@features/habits/types';

export type SuggestionAction =
  | { kind: 'navigate'; href: string }
  | { kind: 'completeTask'; taskId: string }
  | { kind: 'completeHabit'; habitId: string };

export interface Suggestion {
  id: string;
  type: 'streak' | 'overdue' | 'habits_pending' | 'plan_day' | 'focus' | 'priority';
  title: string;
  message: string;
  actionLabel: string;
  action: SuggestionAction;
  urgency: 'low' | 'medium' | 'high';
}

const DISMISS_PREFIX = 'ai_suggestion_dismissed_';

function todayKey() {
  return format(new Date(), 'yyyy-MM-dd');
}

export async function loadDismissed(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(DISMISS_PREFIX + todayKey());
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export async function dismissSuggestion(id: string): Promise<void> {
  const set = await loadDismissed();
  set.add(id);
  await AsyncStorage.setItem(DISMISS_PREFIX + todayKey(), JSON.stringify([...set]));
}

export async function pruneOldDismissed(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const today = DISMISS_PREFIX + todayKey();
    const stale = keys.filter((k) => k.startsWith(DISMISS_PREFIX) && k !== today);
    if (stale.length) await AsyncStorage.multiRemove(stale);
  } catch {
    // ignore
  }
}

interface BuildContext {
  tasks: Task[];
  habits: HabitWithLogs[];
  habitStreaks: Record<string, number>;
  hour: number;
}

export function buildSuggestions(ctx: BuildContext): Suggestion[] {
  const { tasks, habits, habitStreaks, hour } = ctx;
  const today = format(new Date(), 'yyyy-MM-dd');
  const out: Suggestion[] = [];

  // 1. Breaking streak: habit with streak ≥3 not completed today
  for (const h of habits) {
    const streak = habitStreaks[h.id] ?? 0;
    if (streak < 3) continue;
    const log = h.logs?.find((l) => l.date?.split('T')[0] === today);
    const done = (log?.completedCount ?? 0) >= (h.targetFrequency ?? 1);
    if (!done && hour >= 12) {
      out.push({
        id: `streak_${h.id}`,
        type: 'streak',
        title: `${streak}-day streak at risk`,
        message: `Don't break your streak on "${h.name}" — take 2 minutes now.`,
        actionLabel: 'Log now',
        action: { kind: 'completeHabit', habitId: h.id },
        urgency: 'high',
      });
    }
  }

  // 2. Overdue tasks
  const nowTs = Date.now();
  const overdue = tasks.filter((t) => {
    if (t.status === 'completed') return false;
    if (!t.dueDate) return false;
    return new Date(t.dueDate).getTime() < nowTs - 24 * 60 * 60 * 1000;
  });
  if (overdue.length > 0) {
    out.push({
      id: `overdue_${overdue.length}`,
      type: 'overdue',
      title: `${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}`,
      message: `"${overdue[0]!.title}" and ${overdue.length - 1 > 0 ? `${overdue.length - 1} other${overdue.length - 1 > 1 ? 's' : ''}` : 'more'} need attention.`,
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/(app)/(tabs)/manual' },
      urgency: 'high',
    });
  }

  // 3. Habits pending in afternoon/evening
  if (hour >= 15 && habits.length > 0) {
    const pendingCount = habits.filter((h) => {
      const log = h.logs?.find((l) => l.date?.split('T')[0] === today);
      return (log?.completedCount ?? 0) < (h.targetFrequency ?? 1);
    }).length;
    const ratio = pendingCount / habits.length;
    if (ratio >= 0.5 && pendingCount > 0) {
      out.push({
        id: `habits_pending_${pendingCount}`,
        type: 'habits_pending',
        title: `${pendingCount} habits still pending`,
        message: `It's ${hour}:00 — knock a few out before the day ends.`,
        actionLabel: 'Open manual mode',
        action: { kind: 'navigate', href: '/(app)/(tabs)/manual' },
        urgency: 'medium',
      });
    }
  }

  // 4. Empty day: no tasks scheduled for today, it's after 9am
  if (hour >= 9 && hour < 20 && tasks.length === 0) {
    out.push({
      id: 'plan_day',
      type: 'plan_day',
      title: 'Your day is unplanned',
      message: 'A quick 2-minute plan now beats an hour of drift later.',
      actionLabel: 'Plan now',
      action: { kind: 'navigate', href: '/(app)/(tabs)/manual' },
      urgency: 'medium',
    });
  }

  // 6. Many open tasks but no high priority
  const openTasks = tasks.filter((t) => t.status !== 'completed');
  if (openTasks.length >= 10 && !openTasks.some((t) => t.priority === 'high')) {
    out.push({
      id: 'priority_review',
      type: 'priority',
      title: `${openTasks.length} open tasks, no priorities set`,
      message: 'Pick 1–2 to mark high priority so focus is obvious.',
      actionLabel: 'Review',
      action: { kind: 'navigate', href: '/(app)/(tabs)/manual' },
      urgency: 'low',
    });
  }

  const urgencyRank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => urgencyRank[a.urgency] - urgencyRank[b.urgency]);
}
