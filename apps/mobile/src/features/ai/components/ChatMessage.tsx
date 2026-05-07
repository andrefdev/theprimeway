import { View, Image } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Text } from '@/shared/components/ui/text';
import { cn } from '@/shared/utils/cn';
import { FenrirGlyph } from '@/shared/components/icons/FenrirGlyph';
import { ToolCallCard, type ToolCall } from './ToolCallCard';
import { MarkdownRenderer } from './MarkdownRenderer';

export interface ChatAttachment {
  id: string;
  uri: string;
  mediaType: string;
  base64?: string;
}

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
}

export function ChatMessage({ message }: { message: ChatMessageData }) {
  const isUser = message.role === 'user';

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      className={cn('max-w-[85%]', isUser ? 'self-end' : 'self-start')}
    >
      <View
        className={cn(
          'rounded-3xl px-4 py-3',
          isUser
            ? 'rounded-br-lg bg-primary'
            : 'rounded-bl-lg border border-border/70 bg-card'
        )}
      >
        {!isUser && (
          <View className="mb-1 flex-row items-center gap-1.5">
            <View className="h-4 w-4 items-center justify-center rounded-md bg-accent/15">
              <FenrirGlyph size={10} />
            </View>
          </View>
        )}

        {isUser ? (
          <View className="gap-2">
            {message.attachments && message.attachments.length > 0 && (
              <View className="flex-row flex-wrap gap-2">
                {message.attachments.map((att) => (
                  <Image
                    key={att.id}
                    source={{ uri: att.uri }}
                    className="rounded-2xl"
                    style={{ width: 160, height: 160 }}
                    resizeMode="cover"
                  />
                ))}
              </View>
            )}
            {message.content ? (
              <Text className="text-sm leading-5 text-primary-foreground">
                {message.content}
              </Text>
            ) : null}
          </View>
        ) : (
          <View>
            {message.content ? (
              <MarkdownRenderer content={message.content} />
            ) : null}
            {message.isStreaming && (
              <Text className="text-accent"> ▍</Text>
            )}
          </View>
        )}
      </View>

      {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
        <View className="mt-1.5 gap-1.5">
          {message.toolCalls.map((tc, idx) => (
            <ToolCallCard key={`${tc.toolName}-${idx}`} toolCall={tc} />
          ))}
        </View>
      )}
    </Animated.View>
  );
}
