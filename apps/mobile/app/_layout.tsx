import '../global.css';

import { NAV_THEME } from '../lib/theme';
import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryProvider } from '@/shared/providers/QueryProvider';
import { AuthProvider } from '@/shared/providers/AuthProvider';
import { useAuthStore } from '@/shared/stores/authStore';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { OfflineBanner } from '@/shared/components/ui/offline-banner';
import { Toaster } from '@/shared/components/ui/toaster';
import {
  registerForPushNotifications,
  addNotificationResponseListener,
} from '@features/notifications';
import { setupTimerChannel } from '@features/notifications';
import { setupReminderChannel } from '@features/notifications';
import { restoreMorningBriefing } from '@features/notifications';
import { pruneOldQuotas } from '@features/notifications';
import { pruneOldDismissed } from '@features/ai';
import { registerMutationDefaults } from '@/shared/offline/mutationDefaults';
import { routeFromNotification } from '@features/notifications';
import * as Notifications from 'expo-notifications';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync();

// Register mutation defaults synchronously before the tree mounts so that
// paused mutations hydrated from AsyncStorage can be resumed.
registerMutationDefaults();

export default function RootLayout() {
  const { colorScheme } = useColorScheme();
  const isLoading = useAuthStore((s) => s.isLoading);

  useEffect(() => {
    if (!isLoading) {
      SplashScreen.hideAsync();
    }
  }, [isLoading]);

  // Register push notifications and notification channels on app start
  useEffect(() => {
    setupTimerChannel();
    setupReminderChannel();
    registerForPushNotifications();
    restoreMorningBriefing();
    pruneOldQuotas();
    pruneOldDismissed();

    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp) routeFromNotification(resp);
    });

    const sub = addNotificationResponseListener(routeFromNotification);
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={NAV_THEME[colorScheme ?? 'dark']}>
        <QueryProvider>
          <AuthProvider>
            <BottomSheetModalProvider>
              <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(onboarding)" />
                <Stack.Screen name="(app)" />
              </Stack>
              <PortalHost />
              <OfflineBanner />
              <Toaster />
            </BottomSheetModalProvider>
          </AuthProvider>
        </QueryProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
