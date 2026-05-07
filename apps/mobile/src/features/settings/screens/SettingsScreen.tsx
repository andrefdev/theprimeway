import { useState, useMemo, useCallback, useEffect } from 'react';
import { View, ScrollView, Pressable, TextInput, Modal, Switch } from 'react-native';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import { Card, CardContent } from '@/shared/components/ui/card';
import { Header } from '@/shared/components/layout/Header';
import { useSettingsStore } from '@/shared/stores/settingsStore';
import { setLocale } from '@/i18n';
import { useTranslation } from '@/shared/hooks/useTranslation';
import {
  Globe,
  Palette,
  Clock,
  DollarSign,
  Bell,
  Trash2,
  ChevronRight,
  Search,
  Check,
  X,
  Fingerprint,
  Timer,
} from 'lucide-react-native';
import { useBiometricStore } from '@/shared/stores/biometricStore';
import { useUiStore } from '@/shared/stores/uiStore';
import { isBiometricSupported, authenticateBiometric } from '@features/auth';
import {
  getMorningBriefingSettings,
  scheduleMorningBriefing,
  cancelMorningBriefing,
} from '@features/notifications';
import { getMaxPerDay, setMaxPerDay } from '@features/notifications';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { cn } from '@/shared/utils/cn';
import { useColorScheme } from 'nativewind';
import type { LucideIcon } from 'lucide-react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { FlashList } from '@shopify/flash-list';
import { useUpdateUserSettings } from '@features/settings';

// ─── Timezone list ────────────────────────────────────────────────────────────

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'America/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/Buenos_Aires',
  'America/Caracas',
  'America/La_Paz',
  'America/Asuncion',
  'America/Montevideo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Warsaw',
  'Europe/Prague',
  'Europe/Budapest',
  'Europe/Bucharest',
  'Europe/Athens',
  'Europe/Helsinki',
  'Europe/Stockholm',
  'Europe/Oslo',
  'Europe/Copenhagen',
  'Europe/Moscow',
  'Europe/Istanbul',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'Africa/Casablanca',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Baghdad',
  'Asia/Tehran',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Colombo',
  'Asia/Dhaka',
  'Asia/Kathmandu',
  'Asia/Rangoon',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Kuala_Lumpur',
  'Asia/Manila',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Vladivostok',
  'Australia/Perth',
  'Australia/Darwin',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Hobart',
  'Pacific/Auckland',
  'Pacific/Fiji',
  'Pacific/Honolulu',
  'Pacific/Guam',
  'Pacific/Midway',
];

// ─── Timezone Picker Modal ────────────────────────────────────────────────────

function TimezonePickerModal({
  visible,
  currentTimezone,
  onSelect,
  onClose,
}: {
  visible: boolean;
  currentTimezone: string;
  onSelect: (tz: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('features.settings');
  const [search, setSearch] = useState('');
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return TIMEZONES;
    return TIMEZONES.filter((tz) => tz.toLowerCase().includes(q));
  }, [search]);

  const renderItem = useCallback(
    ({ item }: { item: string }) => {
      const isSelected = item === currentTimezone;
      return (
        <Pressable
          className={cn(
            'flex-row items-center justify-between px-4 py-3.5 active:bg-muted',
            isSelected && 'bg-primary/10'
          )}
          onPress={() => {
            onSelect(item);
            onClose();
          }}
        >
          <Text
            className={cn(
              'flex-1 text-sm',
              isSelected ? 'font-semibold text-primary' : 'text-foreground'
            )}
          >
            {item}
          </Text>
          {isSelected && <Icon as={Check} size={16} className="text-primary" />}
        </Pressable>
      );
    },
    [currentTimezone, onSelect, onClose]
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        className="flex-1 bg-background"
        edges={['top', 'bottom']}
      >
        {/* Header */}
        <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <Text className="text-lg font-semibold text-foreground">{t('timezone.select')}</Text>
          <Pressable
            className="h-8 w-8 items-center justify-center rounded-full bg-muted active:bg-border"
            onPress={onClose}
          >
            <Icon as={X} size={18} className="text-foreground" />
          </Pressable>
        </View>

        {/* Search */}
        <View className="border-b border-border px-4 py-3">
          <View className="flex-row items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
            <Icon as={Search} size={16} className="text-muted-foreground" />
            <TextInput
              className="flex-1 text-sm text-foreground"
              placeholder={t('timezone.search')}
              placeholderTextColor={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)'}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch('')}>
                <Icon as={X} size={14} className="text-muted-foreground" />
              </Pressable>
            )}
          </View>
        </View>

        {/* List */}
        <FlashList
          data={filtered}
          renderItem={renderItem}
          keyExtractor={(item) => item}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View className="mx-4 h-px bg-border/50" />}
          ListEmptyComponent={
            <View className="items-center py-12">
              <Text className="text-sm text-muted-foreground">{t('timezone.empty')}</Text>
            </View>
          }
        />
      </SafeAreaView>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export function SettingsScreen() {
  const { t } = useTranslation('features.settings');
  const settings = useSettingsStore();
  const { toggleColorScheme, colorScheme } = useColorScheme();
  const [timezonePickerOpen, setTimezonePickerOpen] = useState(false);
  const { mutate: updateSettings } = useUpdateUserSettings();

  const handleLanguageChange = () => {
    const newLocale = settings.locale === 'en' ? 'es' : 'en';
    settings.setLocale(newLocale);
    setLocale(newLocale);
  };

  const handleTimezoneSelect = (timezone: string) => {
    // Update local store immediately for instant UI feedback
    settings.setTimezone(timezone);
    // Persist to backend
    updateSettings({ timezone });
  };

  const handleDeleteAccount = () => {
    router.push('/(app)/delete-account');
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <Header title={t('title')} showBack />

      <ScrollView className="flex-1" contentContainerClassName="px-4 pb-8">
        {/* Preferences */}
        <Animated.View entering={FadeInDown.duration(300)}>
          <SectionTitle title={t('theme.title')} />
          <Card>
            <CardContent className="gap-0 p-0">
              <SettingRow
                icon={Palette}
                label={t('theme.title')}
                value={colorScheme === 'dark' ? t('theme.dark') : t('theme.light')}
                onPress={toggleColorScheme}
              />
              <Divider />
              <SettingRow
                icon={Globe}
                label={t('language.title')}
                value={settings.locale === 'en' ? 'English' : 'Español'}
                onPress={handleLanguageChange}
              />
              <Divider />
              <SettingRow
                icon={Clock}
                label={t('timezone.title')}
                value={settings.timezone}
                onPress={() => setTimezonePickerOpen(true)}
              />
              <Divider />
              <SettingRow
                icon={DollarSign}
                label={t('currency.title')}
                value={settings.baseCurrency}
                onPress={() => {
                  const next = settings.baseCurrency === 'USD' ? 'PEN' : 'USD';
                  settings.setBaseCurrency(next);
                }}
              />
            </CardContent>
          </Card>
        </Animated.View>

        {/* Notifications */}
        <Animated.View entering={FadeInDown.delay(50).duration(300)}>
          <SectionTitle title={t('notifications.title')} />
          <Card>
            <CardContent className="gap-0 p-0">
              <SettingRow
                icon={Bell}
                label={t('notifications.title')}
                showChevron
                onPress={() => {}}
              />
              <Divider />
              <MorningBriefingRow />
              <Divider />
              <FocusModeRow />
              <Divider />
              <MaxNotificationsRow />
            </CardContent>
          </Card>
        </Animated.View>

        {/* Security */}
        <Animated.View entering={FadeInDown.delay(75).duration(300)}>
          <SectionTitle title={t('security.title')} />
          <Card>
            <CardContent className="gap-0 p-0">
              <BiometricToggleRow />
            </CardContent>
          </Card>
        </Animated.View>

        {/* Danger Zone */}
        <Animated.View entering={FadeInDown.delay(150).duration(300)}>
          <SectionTitle title={t('dangerZone.title')} />
          <Pressable
            className="flex-row items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4 active:bg-destructive/10"
            onPress={handleDeleteAccount}
          >
            <Icon as={Trash2} size={18} className="text-destructive" />
            <Text className="flex-1 text-sm font-medium text-destructive">{t('deleteAccount.title')}</Text>
            <Icon as={ChevronRight} size={16} className="text-destructive/50" />
          </Pressable>
        </Animated.View>

        {/* Version */}
        <View className="mt-8 items-center">
          <Text className="text-2xs text-muted-foreground">{t('version', { version: '2.0.0' })}</Text>
        </View>
      </ScrollView>

      {/* Timezone Picker Modal */}
      <TimezonePickerModal
        visible={timezonePickerOpen}
        currentTimezone={settings.timezone}
        onSelect={handleTimezoneSelect}
        onClose={() => setTimezonePickerOpen(false)}
      />
    </SafeAreaView>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SectionTitle({ title }: { title: string }) {
  return (
    <Text className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {title}
    </Text>
  );
}

function Divider() {
  return <View className="mx-4 h-px bg-border" />;
}

function MaxNotificationsRow() {
  const { t } = useTranslation('features.settings');
  const [max, setMax] = useState(5);

  useEffect(() => {
    getMaxPerDay().then(setMax);
  }, []);

  const change = async (delta: number) => {
    const next = Math.max(1, Math.min(50, max + delta));
    setMax(next);
    await setMaxPerDay(next);
  };

  return (
    <View className="flex-row items-center justify-between px-4 py-3.5">
      <View className="flex-1 flex-row items-center gap-3">
        <Icon as={Bell} size={18} className="text-muted-foreground" />
        <View className="flex-1">
          <Text className="text-sm font-medium text-foreground">{t('notifications.maxPerDay')}</Text>
          <Text className="text-xs text-muted-foreground">{t('notifications.maxPerDayDescription')}</Text>
        </View>
      </View>
      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={() => change(-1)}
          className="h-7 w-7 items-center justify-center rounded-md border border-border active:bg-muted"
        >
          <Text className="text-sm text-foreground">−</Text>
        </Pressable>
        <Text className="w-6 text-center text-sm font-semibold text-foreground">{max}</Text>
        <Pressable
          onPress={() => change(1)}
          className="h-7 w-7 items-center justify-center rounded-md border border-border active:bg-muted"
        >
          <Text className="text-sm text-foreground">+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function FocusModeRow() {
  const { t } = useTranslation('features.settings');
  const enabled = useUiStore((s) => s.focusModeSilence);
  const setEnabled = useUiStore((s) => s.setFocusModeSilence);
  return (
    <View className="flex-row items-center justify-between px-4 py-3.5">
      <View className="flex-row items-center gap-3">
        <Icon as={Timer} size={18} className="text-muted-foreground" />
        <View>
          <Text className="text-sm font-medium text-foreground">{t('notifications.focusSilence')}</Text>
          <Text className="text-xs text-muted-foreground">{t('notifications.focusSilenceDescription')}</Text>
        </View>
      </View>
      <Switch value={enabled} onValueChange={setEnabled} />
    </View>
  );
}

function MorningBriefingRow() {
  const { t } = useTranslation('features.settings');
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(0);

  useEffect(() => {
    getMorningBriefingSettings().then((s) => {
      setEnabled(s.enabled);
      setHour(s.hour);
      setMinute(s.minute);
    });
  }, []);

  const handleToggle = async (v: boolean) => {
    if (v) {
      await scheduleMorningBriefing(hour, minute);
    } else {
      await cancelMorningBriefing();
    }
    setEnabled(v);
  };

  const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  return (
    <View className="flex-row items-center justify-between px-4 py-3.5">
      <View className="flex-row items-center gap-3">
        <Icon as={Bell} size={18} className="text-muted-foreground" />
        <View>
          <Text className="text-sm font-medium text-foreground">{t('notifications.morningBriefing')}</Text>
          <Text className="text-xs text-muted-foreground">{t('notifications.dailyAt', { time: timeLabel })}</Text>
        </View>
      </View>
      <Switch value={enabled} onValueChange={handleToggle} />
    </View>
  );
}

function BiometricToggleRow() {
  const { t } = useTranslation('features.settings');
  const enabled = useBiometricStore((s) => s.enabled);
  const setEnabled = useBiometricStore((s) => s.setEnabled);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    isBiometricSupported().then(setSupported);
  }, []);

  const handleToggle = async (value: boolean) => {
    if (value) {
      const ok = await authenticateBiometric(t('security.enableBiometric'));
      if (!ok) return;
    }
    await setEnabled(value);
  };

  return (
    <View className="flex-row items-center justify-between px-4 py-3.5">
      <View className="flex-row items-center gap-3">
        <Icon as={Fingerprint} size={18} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">{t('security.biometricUnlock')}</Text>
      </View>
      <Switch
        value={enabled}
        onValueChange={handleToggle}
        disabled={!supported}
      />
    </View>
  );
}

function SettingRow({
  icon,
  label,
  value,
  onPress,
  showChevron,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  onPress?: () => void;
  showChevron?: boolean;
}) {
  return (
    <Pressable
      className="flex-row items-center justify-between px-4 py-3.5 active:bg-muted"
      onPress={onPress}
    >
      <View className="flex-row items-center gap-3">
        <Icon as={icon} size={18} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">{label}</Text>
      </View>
      <View className="flex-row items-center gap-2">
        {value && (
          <Text className="max-w-[160px] text-right text-sm text-muted-foreground" numberOfLines={1}>
            {value}
          </Text>
        )}
        {(showChevron || onPress) && <Icon as={ChevronRight} size={16} className="text-muted-foreground/50" />}
      </View>
    </Pressable>
  );
}
