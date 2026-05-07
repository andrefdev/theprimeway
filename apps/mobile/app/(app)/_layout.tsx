import { View } from 'react-native';
import { useAuthStore } from '@/shared/stores/authStore';
import { Redirect, Stack } from 'expo-router';
import { CelebrationOverlay } from '@features/gamification';
import { BiometricGate } from '@features/auth';

export default function AppLayout() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);

  if (isLoading) return null;

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <BiometricGate>
      <View className="flex-1">
        <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="calendar" />
        <Stack.Screen name="pomodoro" options={{ presentation: 'modal' }} />
        <Stack.Screen name="profile" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="subscription" />
        <Stack.Screen name="customize-section" options={{ presentation: 'modal' }} />
        <Stack.Screen name="weekly-review" />
        <Stack.Screen name="alignment-setup" />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="habits-analytics" />
        <Stack.Screen name="brain/index" />
        <Stack.Screen name="brain/[id]" />
        <Stack.Screen name="delete-account" />
        </Stack>
        <CelebrationOverlay />
      </View>
    </BiometricGate>
  );
}
