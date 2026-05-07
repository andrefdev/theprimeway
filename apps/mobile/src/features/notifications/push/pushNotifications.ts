import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { apiClient } from '@shared/api/client';
import { NOTIFICATIONS } from '@shared/api/endpoints';
import { canSendNotification, recordNotificationSent, type NotifPriority } from '../quotas/antifatigue';

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = (notification.request.content.data ?? {}) as { priority?: NotifPriority };
    const priority: NotifPriority = data.priority ?? 'normal';
    const withinQuota = await canSendNotification(priority);

    if (withinQuota) {
      await recordNotificationSent();
    }
    return {
      shouldShowAlert: withinQuota,
      shouldPlaySound: withinQuota,
      shouldSetBadge: true,
      shouldShowBanner: withinQuota,
      shouldShowList: withinQuota,
    };
  },
});

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    console.warn('Push notifications only work on physical devices');
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  const projectId = process.env.EXPO_PUBLIC_PROJECT_ID;
  if (!projectId) return null;

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;

  // Register token with backend
  try {
    await apiClient.post(NOTIFICATIONS.REGISTER, {
      token,
      platform: Platform.OS,
      deviceName: Device.deviceName,
    });
  } catch {
    // Silently fail — token registration is non-critical
  }

  return token;
}

export function addNotificationReceivedListener(
  callback: (notification: Notifications.Notification) => void
) {
  return Notifications.addNotificationReceivedListener(callback);
}

export function addNotificationResponseListener(
  callback: (response: Notifications.NotificationResponse) => void
) {
  return Notifications.addNotificationResponseReceivedListener(callback);
}
