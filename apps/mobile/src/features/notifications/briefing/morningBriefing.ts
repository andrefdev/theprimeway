import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BRIEFING_ID = 'morning-briefing';
const BRIEFING_CHANNEL_ID = 'reminders';
const BRIEFING_KEY = 'morning_briefing_settings';

interface BriefingSettings {
  enabled: boolean;
  hour: number;
  minute: number;
}

const DEFAULT: BriefingSettings = { enabled: false, hour: 7, minute: 0 };

export async function getMorningBriefingSettings(): Promise<BriefingSettings> {
  try {
    const stored = await AsyncStorage.getItem(BRIEFING_KEY);
    return stored ? { ...DEFAULT, ...JSON.parse(stored) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

async function saveSettings(s: BriefingSettings) {
  await AsyncStorage.setItem(BRIEFING_KEY, JSON.stringify(s));
}

export async function scheduleMorningBriefing(hour: number, minute: number) {
  await cancelMorningBriefing();
  await Notifications.scheduleNotificationAsync({
    identifier: BRIEFING_ID,
    content: {
      title: '☀️ Good morning',
      body: 'Your daily briefing is ready. Tap to see today\'s plan.',
      data: { type: 'morning_briefing', priority: 'high' },
      sound: true,
      priority: Notifications.AndroidNotificationPriority.HIGH,
      interruptionLevel: 'timeSensitive',
      ...(Platform.OS === 'android' && { channelId: BRIEFING_CHANNEL_ID }),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute,
    },
  });
  await saveSettings({ enabled: true, hour, minute });
}

export async function cancelMorningBriefing() {
  await Notifications.cancelScheduledNotificationAsync(BRIEFING_ID).catch(() => {});
  const cur = await getMorningBriefingSettings();
  await saveSettings({ ...cur, enabled: false });
}

export async function restoreMorningBriefing() {
  const s = await getMorningBriefingSettings();
  if (s.enabled) {
    await scheduleMorningBriefing(s.hour, s.minute);
  }
}
