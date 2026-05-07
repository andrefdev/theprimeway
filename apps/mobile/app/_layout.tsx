import '../global.css';

import { NAV_THEME } from '../lib/theme';
import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { useCallback, useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryProvider } from '@/shared/providers/QueryProvider';
import { AuthProvider } from '@/shared/providers/AuthProvider';
import { useAuthStore } from '@/shared/stores/authStore';
import { useFeaturesStore } from '@/shared/stores/featuresStore';
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
const __BOOT_T0 = Date.now();
const __bootLog = (msg: string) =>
  console.log(`[BOOT +${Date.now() - __BOOT_T0}ms] ${msg}`);
__bootLog('module: _layout.tsx evaluated');
// Safety fallback: force-hide the splash after 8s so a hung init path
// reveals what's behind it instead of leaving the user on the splash forever.
setTimeout(() => {
  __bootLog('FALLBACK splash hideAsync');
  SplashScreen.hideAsync().catch(() => {});
}, 8000);

// Register mutation defaults synchronously before the tree mounts so that
// paused mutations hydrated from AsyncStorage can be resumed.
registerMutationDefaults();
__bootLog('module: registerMutationDefaults done');
export { __bootLog };

export default function RootLayout() {
  const { colorScheme } = useColorScheme();
  const isLoading = useAuthStore((s) => s.isLoading);
  const loadStoredAuth = useAuthStore((s) => s.loadStoredAuth);
  const loadStoredFeatures = useFeaturesStore((s) => s.loadStoredFeatures);
  __bootLog(`RootLayout render isLoading=${isLoading}`);

  // Kick off boot work even while we keep the splash visible (we render null
  // below until isLoading flips false, so this useEffect is the only path
  // that fires loadStoredAuth on cold start).
  useEffect(() => {
    loadStoredAuth();
    loadStoredFeatures();
  }, [loadStoredAuth, loadStoredFeatures]);

  // Register push notifications and notification channels on app start.
  // Wait until isLoading flips false so the router is mounted before any
  // routeFromNotification() can fire.
  useEffect(() => {
    if (isLoading) return;
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
  }, [isLoading]);

  // Hide the splash only once the real tree has been laid out, so users
  // never see a black gap between the splash and the first screen.
  const onRootLayout = useCallback(() => {
    __bootLog('onRootLayout — hiding splash');
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  // Keep the splash visible until boot work completes. Returning null here
  // means the React tree below stays unmounted while loading, so when we do
  // mount it the splash hides exactly when the first frame is ready.
  if (isLoading) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={onRootLayout}>
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
