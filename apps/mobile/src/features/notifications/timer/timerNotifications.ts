import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const TIMER_CHANNEL_ID = 'timer-persistent';
const TASK_TIMER_NOTIF_ID = 'task-timer';

/**
 * Creates the Android notification channel for persistent task timer notifications.
 * Uses IMPORTANCE_HIGH so it behaves like a native timer that stays on lock-screen.
 */
export async function setupTimerChannel() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(TIMER_CHANNEL_ID, {
      name: 'Timer',
      description: 'Persistent timer notifications for task timers',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 0],
      sound: undefined,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      enableVibrate: false,
      showBadge: false,
    });
  }
}

function formatMMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ────────────────────────────────────────────────
// TASK TIMER PERSISTENT NOTIFICATION
// ────────────────────────────────────────────────

/**
 * Shows/updates the ongoing task timer notification.
 */
export async function showTaskTimerNotification(
  elapsedSeconds: number,
  taskTitle: string,
  plannedMinutes?: number
) {
  const elapsed = formatMMSS(elapsedSeconds);
  const planned = plannedMinutes ? formatMMSS(plannedMinutes * 60) : null;
  const body = planned
    ? `${elapsed} / ${planned}`
    : `${elapsed} elapsed`;

  await Notifications.scheduleNotificationAsync({
    identifier: TASK_TIMER_NOTIF_ID,
    content: {
      title: `⏱ ${taskTitle}`,
      body,
      sound: false,
      sticky: true,
      autoDismiss: false,
      priority: Notifications.AndroidNotificationPriority.HIGH,
      ...(Platform.OS === 'android' && {
        channelId: TIMER_CHANNEL_ID,
      }),
    },
    trigger: null,
  });
}

/**
 * Dismisses the ongoing task timer notification.
 */
export async function dismissTaskTimerNotification() {
  await Notifications.dismissNotificationAsync(TASK_TIMER_NOTIF_ID).catch(() => {});
}
