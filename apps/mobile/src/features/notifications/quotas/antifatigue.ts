import AsyncStorage from '@react-native-async-storage/async-storage';

const QUOTA_PREFIX = 'notif_quota_';
const MAX_KEY = 'notif_max_per_day';
const DEFAULT_MAX = 5;

export type NotifPriority = 'low' | 'normal' | 'high';

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${QUOTA_PREFIX}${y}-${m}-${day}`;
}

export async function getMaxPerDay(): Promise<number> {
  const v = await AsyncStorage.getItem(MAX_KEY);
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX;
}

export async function setMaxPerDay(max: number): Promise<void> {
  await AsyncStorage.setItem(MAX_KEY, String(Math.max(1, Math.min(50, max))));
}

export async function getTodayCount(): Promise<number> {
  const v = await AsyncStorage.getItem(todayKey());
  const n = v ? parseInt(v, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function canSendNotification(priority: NotifPriority = 'normal'): Promise<boolean> {
  if (priority === 'high') return true;
  const [count, max] = await Promise.all([getTodayCount(), getMaxPerDay()]);
  return count < max;
}

export async function recordNotificationSent(): Promise<void> {
  const key = todayKey();
  const current = await getTodayCount();
  await AsyncStorage.setItem(key, String(current + 1));
}

export async function pruneOldQuotas(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const today = todayKey();
    const stale = keys.filter((k) => k.startsWith(QUOTA_PREFIX) && k !== today);
    if (stale.length) await AsyncStorage.multiRemove(stale);
  } catch {
    // ignore
  }
}
