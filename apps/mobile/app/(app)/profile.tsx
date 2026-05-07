import { View, ScrollView, TextInput, Alert, Pressable } from 'react-native';
import { Text } from '@/shared/components/ui/text';
import { Card, CardContent } from '@/shared/components/ui/card';
import { Button } from '@/shared/components/ui/button';
import { Icon } from '@/shared/components/ui/icon';
import { Header } from '@/shared/components/layout/Header';
import { LevelBadge } from '@features/gamification';
import { ProgressRing } from '@features/gamification';
import { useGamificationStore } from '@features/gamification';
import { useAuthStore } from '@/shared/stores/authStore';
import { Camera, LogOut, Zap, Flame, Trophy } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState, useEffect } from 'react';
import { router } from 'expo-router';
import { getInitials } from '@/shared/utils/format';
import { useTranslation } from '@/shared/hooks/useTranslation';
import Animated, { FadeInDown } from 'react-native-reanimated';

export default function ProfileScreen() {
  const { t } = useTranslation('auth.profile');
  const { t: tCommon } = useTranslation('common');
  const { t: tAuth } = useTranslation('auth.common');
  const { user, logout } = useAuthStore();
  const [name, setName] = useState(user?.name || '');
  const initials = getInitials(user?.name || 'U');
  const totalXp = useGamificationStore((s) => s.totalXp);
  const currentStreak = useGamificationStore((s) => s.currentStreak);
  const longestStreak = useGamificationStore((s) => s.longestStreak);
  const storeLevel = useGamificationStore((s) => s.level);
  const levelName = useGamificationStore((s) => s.levelName);
  const xpInCurrentLevel = useGamificationStore((s) => s.xpInCurrentLevel);
  const xpToNextLevel = useGamificationStore((s) => s.xpToNextLevel);
  const rank = useGamificationStore((s) => s.rank);
  const syncWithBackend = useGamificationStore((s) => s.syncWithBackend);
  const levelProgress = xpToNextLevel > 0 ? xpInCurrentLevel / xpToNextLevel : 1;
  const level = { level: storeLevel, name: levelName };

  useEffect(() => {
    syncWithBackend();
  }, []);

  const handleLogout = () => {
    Alert.alert(tAuth('logout'), t('logoutConfirm'), [
      { text: tCommon('actions.cancel'), style: 'cancel' },
      {
        text: tAuth('logout'),
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <Header title={t('title')} showBack />

      <ScrollView className="flex-1" contentContainerClassName="px-4 pb-8">
        {/* Avatar Section with Level Ring */}
        <Animated.View entering={FadeInDown.duration(300)} className="mt-4 items-center">
          <View className="relative items-center justify-center" style={{ width: 96, height: 96 }}>
            <ProgressRing progress={levelProgress} size={96} strokeWidth={3} color="hsl(45, 93%, 47%)" />
            <View className="absolute h-20 w-20 items-center justify-center rounded-full bg-primary/15">
              <Text className="text-2xl font-bold text-primary">{initials}</Text>
            </View>
            <Pressable className="absolute -bottom-1 -right-1 h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-primary">
              <Icon as={Camera} size={12} className="text-primary-foreground" />
            </Pressable>
          </View>
          <View className="mt-3 items-center gap-1">
            <Text className="text-lg font-bold text-foreground">{user?.name}</Text>
            <LevelBadge xp={totalXp} size="md" />
            <Text className="text-sm text-muted-foreground">{user?.email}</Text>
          </View>
        </Animated.View>

        {/* Gamification Stats */}
        <Animated.View entering={FadeInDown.delay(30).duration(300)} className="mt-4 flex-row gap-3">
          <View className="flex-1 items-center rounded-xl border border-border bg-card py-3">
            <Icon as={Zap} size={18} className="text-xp" />
            <Text className="mt-1 text-lg font-bold text-foreground">{totalXp}</Text>
            <Text className="text-2xs text-muted-foreground">{t('totalXp')}</Text>
          </View>
          <View className="flex-1 items-center rounded-xl border border-border bg-card py-3">
            <Icon as={Trophy} size={18} className="text-level-gold" />
            <Text className="mt-1 text-lg font-bold text-foreground">Lv.{level.level}</Text>
            <Text className="text-2xs text-muted-foreground">{level.name}</Text>
          </View>
          <View className="flex-1 items-center rounded-xl border border-border bg-card py-3">
            <Icon as={Flame} size={18} className="text-streak-fire" />
            <Text className="mt-1 text-lg font-bold text-foreground">{currentStreak}d</Text>
            <Text className="text-2xs text-muted-foreground">{t('streak')}</Text>
          </View>
        </Animated.View>

        {/* Edit Form */}
        <Animated.View entering={FadeInDown.delay(100).duration(300)} className="mt-6">
          <Text className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            {t('personalInfo')}
          </Text>
          <Card>
            <CardContent className="gap-4">
              <View className="gap-1.5">
                <Text className="text-xs font-medium text-muted-foreground">{t('displayName')}</Text>
                <TextInput
                  className="h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                  value={name}
                  onChangeText={setName}
                />
              </View>

              <View className="gap-1.5">
                <Text className="text-xs font-medium text-muted-foreground">{t('email')}</Text>
                <View className="h-10 justify-center rounded-lg border border-border bg-muted px-3">
                  <Text className="text-sm text-muted-foreground">{user?.email}</Text>
                </View>
              </View>
            </CardContent>
          </Card>
        </Animated.View>

        {/* Logout */}
        <Animated.View entering={FadeInDown.delay(150).duration(300)} className="mt-8">
          <Button variant="destructive" className="w-full" onPress={handleLogout}>
            <Icon as={LogOut} size={16} className="text-white" />
            <Text className="text-sm font-medium text-white">{tAuth('logout')}</Text>
          </Button>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}
