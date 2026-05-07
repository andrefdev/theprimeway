import { ScrollView, View, Pressable, KeyboardAvoidingView, Platform } from 'react-native';
import { useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import {
  BarChart3,
  CheckSquare,
  History,
  MoreHorizontal,
  Plus,
  Sparkles,
  Target,
} from 'lucide-react-native';
import { useAuthStore } from '@/shared/stores/authStore';
import { useTranslation } from '@/shared/hooks/useTranslation';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { useChatStream } from '../hooks/useChatStream';
import { useSpeechLang } from '../hooks/useSpeechLang';

const SUGGESTIONS = [
  { icon: CheckSquare, key: 'firstAction' },
  { icon: BarChart3, key: 'progressRead' },
  { icon: Target, key: 'alignTasks' },
] as const;

export function ChatPanel() {
  const { t } = useTranslation('features.ai');
  const user = useAuthStore((s) => s.user);
  const { messages, isLoading, sendMessage, reset } = useChatStream();
  const [input, setInput] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const tabBarHeight = useBottomTabBarHeight();
  const speechLang = useSpeechLang(messages);

  const handleSend = (text?: string, attachments?: import('./ChatMessage').ChatAttachment[]) => {
    const value = text ?? input;
    const hasAttachments = !!attachments && attachments.length > 0;
    if (!value.trim() && !hasAttachments) return;
    setInput('');
    sendMessage(value, attachments ?? []);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
  };

  const lastMessage = messages[messages.length - 1];
  const showTypingIndicator =
    isLoading && lastMessage?.isStreaming && lastMessage?.content === '';

  return (
    <KeyboardAvoidingView
      className="flex-1"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={tabBarHeight}
    >
      <View className="flex-row items-center justify-between px-5 pb-2 pt-2">
        <View>
          <Text className="text-xs font-semibold text-muted-foreground">{t('companion.eyebrow')}</Text>
          <Text className="mt-1 text-2xl font-extrabold text-foreground">
            {t('companion.greeting', { name: user?.name?.split(' ')[0] || t('companion.fallbackName') })}
          </Text>
        </View>
        <View className="flex-row gap-2">
          <HeaderButton icon={Plus} onPress={reset} />
          <HeaderButton icon={MoreHorizontal} onPress={() => router.push('/(app)/settings')} />
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        className="flex-1 px-5"
        contentContainerClassName="gap-3 pb-4 pt-2"
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: true })
        }
      >
        {messages.length === 0 && (
          <Animated.View entering={FadeIn.duration(400)} className="pb-4">
            <View className="overflow-hidden rounded-[32px]">
              <LinearGradient
                colors={['#4257ff', '#7552f6']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                className="p-5"
              >
                <View className="h-14 w-14 items-center justify-center rounded-3xl bg-white/20">
                  <Icon as={Sparkles} size={26} className="text-white" />
                </View>
                <Text className="mt-6 text-3xl font-extrabold leading-9 text-white">
                  {t('companion.heroTitle')}
                </Text>
                <Text className="mt-3 text-sm leading-5 text-white/80">
                  {t('companion.heroDescription')}
                </Text>
              </LinearGradient>
            </View>

            <View className="mt-5 gap-3">
              {SUGGESTIONS.map((suggestion, index) => (
                <Animated.View
                  key={suggestion.key}
                  entering={FadeInDown.delay(100 + index * 60).duration(300)}
                >
                  <Pressable
                    onPress={() => handleSend(t(`companion.suggestions.${suggestion.key}`))}
                    className="flex-row items-center gap-3 rounded-3xl border border-border/70 bg-card px-4 py-4 shadow-sm shadow-black/5 active:bg-muted"
                  >
                    <View className="h-11 w-11 items-center justify-center rounded-2xl bg-highlight">
                      <Icon as={suggestion.icon} size={18} className="text-primary" />
                    </View>
                    <Text className="flex-1 text-sm font-semibold leading-5 text-foreground">
                      {t(`companion.suggestions.${suggestion.key}`)}
                    </Text>
                  </Pressable>
                </Animated.View>
              ))}
            </View>

            <Pressable
              onPress={() => router.push('/(app)/(tabs)')}
              className="mt-5 flex-row items-center justify-between rounded-3xl bg-card px-4 py-4"
            >
              <View className="flex-row items-center gap-3">
                <View className="h-11 w-11 items-center justify-center rounded-2xl bg-primary/10">
                  <Icon as={History} size={18} className="text-primary" />
                </View>
                <View>
                  <Text className="text-sm font-bold text-foreground">{t('companion.progressLinkTitle')}</Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">{t('companion.progressLinkDescription')}</Text>
                </View>
              </View>
            </Pressable>
          </Animated.View>
        )}

        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}

        {showTypingIndicator && (
          <Animated.View
            entering={FadeIn.duration(200)}
            className="self-start rounded-3xl rounded-bl-lg border border-border/70 bg-card px-4 py-3"
          >
            <View className="flex-row gap-1">
              <View className="h-2 w-2 animate-pulse-soft rounded-full bg-accent" />
              <View className="h-2 w-2 animate-pulse-soft rounded-full bg-accent/70" />
              <View className="h-2 w-2 animate-pulse-soft rounded-full bg-accent/40" />
            </View>
          </Animated.View>
        )}
      </ScrollView>

      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        disabled={isLoading}
        voiceLang={speechLang}
      />
    </KeyboardAvoidingView>
  );
}

function HeaderButton({ icon, onPress }: { icon: typeof Plus; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-card"
    >
      <Icon as={icon} size={19} className="text-foreground" />
    </Pressable>
  );
}
