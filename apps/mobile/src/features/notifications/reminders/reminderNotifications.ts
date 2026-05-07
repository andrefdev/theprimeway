import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { localTimeToUtc } from '@repo/shared/utils';
import { useSettingsStore } from '@/shared/stores/settingsStore';
import { buildTaskReminderBody } from './taskReminderContext';

interface TaskReminderContext {
  description?: string | null;
  estimatedDurationMinutes?: number | null;
  goalTitle?: string | null;
  priority?: string | null;
}

const REMINDER_CHANNEL_ID = 'reminders';
const REMINDER_LOW_CHANNEL_ID = 'reminders-low';
const HABIT_REMINDER_PREFIX = 'habit-reminder-';
const HABIT_BATCH_PREFIX = 'habit-batch-';
const TASK_REMINDER_PREFIX = 'task-reminder-';
const HABIT_REMINDERS_KEY = 'habit_reminder_settings';

interface HabitReminderSettings {
  [habitId: string]: {
    enabled: boolean;
    hour: number;
    minute: number;
  };
}

/**
 * Creates the Android notification channel for habit/task reminders.
 */
export async function setupReminderChannel() {
  if (Platform.OS === 'android') {
    // High-importance channel for time-sensitive notifications (tasks, briefings).
    // These bypass DND if the user allows "priority" senders.
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
      name: 'Time-sensitive reminders',
      description: 'Task due dates and morning briefings',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    // Default-importance channel for habit reminders — Android's DND will silence these.
    await Notifications.setNotificationChannelAsync(REMINDER_LOW_CHANNEL_ID, {
      name: 'Habit reminders',
      description: 'Daily habit nudges (respect Do Not Disturb)',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 200],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

// ────────────────────────────────────────────────
// HABIT REMINDERS
// ────────────────────────────────────────────────

/**
 * Schedules a daily reminder for a habit at a specific time.
 *
 * Note: Expo's DAILY trigger fires at the given hour/minute in the device's
 * local timezone, NOT the user's selected `UserSettings.timezone`. If the
 * device tz differs (user travelling without changing settings), reminders
 * will fire at the wrong wall-clock time. Switching to per-occurrence DATE
 * triggers + re-scheduling on app foreground is tracked as a follow-up.
 */
export async function scheduleHabitReminder(
  habitId: string,
  habitName: string,
  hour: number,
  minute: number
) {
  const identifier = `${HABIT_REMINDER_PREFIX}${habitId}`;

  // Cancel existing reminder for this habit
  await cancelHabitReminder(habitId);

  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: `🔄 ${habitName}`,
      body: `Time to work on your habit: ${habitName}`,
      data: { type: 'habit', habitId, priority: 'normal' },
      sound: true,
      priority: Notifications.AndroidNotificationPriority.DEFAULT,
      interruptionLevel: 'active',
      ...(Platform.OS === 'android' && {
        channelId: REMINDER_LOW_CHANNEL_ID,
      }),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute,
    },
  });

  // Save settings
  await saveHabitReminderSetting(habitId, { enabled: true, hour, minute });
}

/**
 * Cancels the daily reminder for a specific habit.
 */
export async function cancelHabitReminder(habitId: string) {
  const identifier = `${HABIT_REMINDER_PREFIX}${habitId}`;
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
  await saveHabitReminderSetting(habitId, { enabled: false, hour: 9, minute: 0 });
}

/**
 * Gets saved reminder settings for all habits.
 */
export async function getHabitReminderSettings(): Promise<HabitReminderSettings> {
  try {
    const stored = await AsyncStorage.getItem(HABIT_REMINDERS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

/**
 * Saves the reminder setting for a specific habit.
 */
async function saveHabitReminderSetting(
  habitId: string,
  setting: { enabled: boolean; hour: number; minute: number }
) {
  const settings = await getHabitReminderSettings();
  settings[habitId] = setting;
  await AsyncStorage.setItem(HABIT_REMINDERS_KEY, JSON.stringify(settings));
}

/**
 * Restores all habit reminders from saved settings, batching habits that share a time slot
 * into a single notification to reduce fatigue.
 */
export async function restoreHabitReminders(habits: { id: string; name: string }[]) {
  const settings = await getHabitReminderSettings();

  await cancelAllHabitReminders();

  const slots = new Map<string, { hour: number; minute: number; names: string[] }>();
  for (const habit of habits) {
    const setting = settings[habit.id];
    if (!setting?.enabled) continue;
    const key = `${setting.hour}:${setting.minute}`;
    const slot = slots.get(key) ?? { hour: setting.hour, minute: setting.minute, names: [] };
    slot.names.push(habit.name);
    slots.set(key, slot);
  }

  for (const [key, slot] of slots.entries()) {
    if (slot.names.length === 1) {
      const habit = habits.find((h) => h.name === slot.names[0]);
      if (habit) await scheduleHabitReminder(habit.id, habit.name, slot.hour, slot.minute);
      continue;
    }
    await Notifications.scheduleNotificationAsync({
      identifier: `${HABIT_BATCH_PREFIX}${key}`,
      content: {
        title: `🔄 ${slot.names.length} habits to do`,
        body: slot.names.join(', '),
        data: { type: 'habit', priority: 'normal' },
        sound: true,
        priority: Notifications.AndroidNotificationPriority.DEFAULT,
        interruptionLevel: 'active',
        ...(Platform.OS === 'android' && { channelId: REMINDER_LOW_CHANNEL_ID }),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: slot.hour,
        minute: slot.minute,
      },
    });
  }
}

async function cancelAllHabitReminders() {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((n) =>
        n.identifier.startsWith(HABIT_REMINDER_PREFIX) || n.identifier.startsWith(HABIT_BATCH_PREFIX)
      )
      .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {}))
  );
}

// ────────────────────────────────────────────────
// TASK REMINDERS
// ────────────────────────────────────────────────

/**
 * Schedules a reminder for a task at its due date (or a configurable time before).
 * Fires 1 hour before the due time, or at 9:00 AM on the due date if no time is set.
 */
export async function scheduleTaskReminder(
  taskId: string,
  taskTitle: string,
  dueDate: string,
  scheduledStart?: string,
  context?: TaskReminderContext
) {
  const identifier = `${TASK_REMINDER_PREFIX}${taskId}`;

  // Cancel existing
  await cancelTaskReminder(taskId);

  let triggerDate: Date;

  if (scheduledStart) {
    // Remind 15 minutes before scheduled start
    triggerDate = new Date(scheduledStart);
    triggerDate.setMinutes(triggerDate.getMinutes() - 15);
  } else {
    // Remind at 9:00 AM on the due date in the user's selected timezone.
    const tz = useSettingsStore.getState().timezone || 'UTC';
    triggerDate = localTimeToUtc(new Date(dueDate), '09:00', tz);
  }

  // Don't schedule if the reminder time has already passed
  if (triggerDate.getTime() <= Date.now()) return;

  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: `📋 Task Reminder`,
      body: buildTaskReminderBody(taskTitle, context ?? {}),
      data: { type: 'task', taskId, priority: 'high' },
      sound: true,
      priority: Notifications.AndroidNotificationPriority.HIGH,
      interruptionLevel: 'timeSensitive',
      ...(Platform.OS === 'android' && {
        channelId: REMINDER_CHANNEL_ID,
      }),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: triggerDate,
    },
  });
}

/**
 * Cancels the reminder for a specific task.
 */
export async function cancelTaskReminder(taskId: string) {
  const identifier = `${TASK_REMINDER_PREFIX}${taskId}`;
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
}

/**
 * Schedules reminders for all tasks with upcoming due dates.
 * Call on app start.
 */
export async function scheduleUpcomingTaskReminders(
  tasks: {
    id: string;
    title: string;
    dueDate?: string;
    scheduledStart?: string;
    description?: string | null;
    estimatedDurationMinutes?: number | null;
    goalTitle?: string | null;
    priority?: string | null;
  }[]
) {
  for (const task of tasks) {
    if (task.dueDate) {
      await scheduleTaskReminder(task.id, task.title, task.dueDate, task.scheduledStart, {
        description: task.description,
        estimatedDurationMinutes: task.estimatedDurationMinutes,
        goalTitle: task.goalTitle,
        priority: task.priority,
      });
    }
  }
}
