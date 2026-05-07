import { View, Pressable, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import {
  ArrowLeft,
  CheckSquare,
  Flame,
  Wallet,
  Bell,
  ChevronRight,
} from 'lucide-react-native';
import {
  useAggregatedNotifications,
  notificationsQueryKey,
} from '@features/notifications';
import type { AppNotification } from '@features/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useState, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';

// Icon per notification type
function NotificationIcon({ type }: { type: AppNotification['type'] }) {
  if (type === 'overdue_task') {
    return (
      <View className="h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
        <Icon as={CheckSquare} size={20} className="text-destructive" />
      </View>
    );
  }
  if (type === 'missed_habit') {
    return (
      <View className="h-10 w-10 items-center justify-center rounded-full bg-orange-500/10">
        <Icon as={Flame} size={20} className="text-orange-500" />
      </View>
    );
  }
  // pending_transaction
  return (
    <View className="h-10 w-10 items-center justify-center rounded-full bg-primary/10">
      <Icon as={Wallet} size={20} className="text-primary" />
    </View>
  );
}

function NotificationItem({ item }: { item: AppNotification }) {
  const handlePress = () => {
    if (item.href) {
      router.push(item.href as never);
    }
  };

  const timeAgo = (() => {
    try {
      return formatDistanceToNow(new Date(item.createdAt), { addSuffix: true });
    } catch {
      return '';
    }
  })();

  return (
    <Pressable
      onPress={handlePress}
      className="flex-row items-center gap-3 border-b border-border px-5 py-4 active:opacity-70"
    >
      <NotificationIcon type={item.type} />
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-semibold text-foreground">{item.title}</Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={2}>
          {item.message}
        </Text>
        {timeAgo ? (
          <Text className="mt-0.5 text-2xs text-muted-foreground/60">{timeAgo}</Text>
        ) : null}
      </View>
      <Icon as={ChevronRight} size={16} className="text-muted-foreground" />
    </Pressable>
  );
}

// Skeleton loader item
function SkeletonItem() {
  return (
    <View className="flex-row items-center gap-3 border-b border-border px-5 py-4">
      <View className="h-10 w-10 rounded-full bg-muted/40" />
      <View className="flex-1 gap-2">
        <View className="h-3.5 w-2/3 rounded-md bg-muted/40" />
        <View className="h-3 w-full rounded-md bg-muted/30" />
        <View className="h-3 w-1/3 rounded-md bg-muted/20" />
      </View>
    </View>
  );
}

function EmptyState() {
  return (
    <View className="flex-1 items-center justify-center gap-3 px-10 py-20">
      <View className="h-16 w-16 items-center justify-center rounded-full bg-primary/10">
        <Icon as={Bell} size={30} className="text-primary" />
      </View>
      <Text className="text-lg font-bold text-foreground">All caught up! 🎉</Text>
      <Text className="text-center text-sm text-muted-foreground">
        You have no pending notifications. Keep up the great work!
      </Text>
    </View>
  );
}

export default function NotificationsScreen() {
  const { data, isLoading } = useAggregatedNotifications();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const notifications = data?.data ?? [];

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
    setRefreshing(false);
  }, [queryClient]);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {/* Header */}
      <View className="flex-row items-center gap-3 border-b border-border px-5 py-4">
        <Pressable
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-card active:opacity-70"
        >
          <Icon as={ArrowLeft} size={20} className="text-foreground" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-foreground">Notifications</Text>
        {data && data.count > 0 && (
          <View className="h-6 min-w-[24px] items-center justify-center rounded-full bg-destructive px-1.5">
            <Text className="text-xs font-bold text-white">{data.count}</Text>
          </View>
        )}
      </View>

      {/* Content */}
      {isLoading ? (
        <View className="flex-1">
          {[1, 2, 3, 4].map((i) => (
            <SkeletonItem key={i} />
          ))}
        </View>
      ) : (
        <FlashList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <NotificationItem item={item} />}
          ListEmptyComponent={<EmptyState />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        />
      )}
    </SafeAreaView>
  );
}
