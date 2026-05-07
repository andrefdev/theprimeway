import type * as Notifications from 'expo-notifications';
import { router } from 'expo-router';

type NotificationData = {
  type?: string;
  taskId?: string;
  habitId?: string;
  screen?: string;
  url?: string;
};

export function routeFromNotification(response: Notifications.NotificationResponse) {
  const data = (response.notification.request.content.data ?? {}) as NotificationData;

  if (data.url) {
    router.push(data.url as any);
    return;
  }

  switch (data.type) {
    case 'task':
    case 'habit':
      router.push('/(app)/(tabs)/manual' as any);
      return;
    case 'morning_briefing':
      router.push('/(app)/(tabs)' as any);
      return;
    case 'ai':
      router.push('/(app)/(tabs)/ai' as any);
      return;
    default:
      break;
  }

  if (data.screen) router.push(data.screen as any);
}
