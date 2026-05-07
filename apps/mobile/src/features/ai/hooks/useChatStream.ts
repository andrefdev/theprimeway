import { useCallback, useRef, useState } from 'react';
import type { ChatAttachment, ChatMessageData } from '../components/ChatMessage';
import { ChatRequestError, chatService } from '../services/chatService';
import { useTranslation } from '@shared/hooks/useTranslation';

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildFallbackMessage(error: unknown, t: (key: string) => string) {
  if (error instanceof ChatRequestError) {
    if (error.status === 403) return t('errors.aiDisabled');
    if (error.status === 429) return t('errors.rateLimited');
    return error.message || t('errors.connection');
  }
  if (error instanceof Error) return error.message;
  return t('errors.connection');
}

export function useChatStream() {
  const { t } = useTranslation('features.ai');
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string, attachments: ChatAttachment[] = []) => {
      const trimmed = text.trim();
      const hasAttachments = attachments.length > 0;
      if ((!trimmed && !hasAttachments) || isLoading) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMessage: ChatMessageData = {
        id: createId(),
        role: 'user',
        content: trimmed,
        attachments: hasAttachments ? attachments : undefined,
      };
      const assistantId = createId();
      const placeholder: ChatMessageData = {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };
      const nextMessages = [...messages, userMessage];

      setMessages((prev) => [...prev, userMessage, placeholder]);
      setIsLoading(true);

      const appendAssistantText = (delta: string) => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, content: `${message.content}${delta}` }
              : message
          )
        );
      };

      const finishAssistant = (patch: Partial<ChatMessageData> = {}) => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, ...patch, isStreaming: false }
              : message
          )
        );
      };

      try {
        const streamResult = await chatService.stream({
          signal: controller.signal,
          messages: nextMessages,
          onDelta: appendAssistantText,
          onToolCalls: (toolCalls) => {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, toolCalls } : message
              )
            );
          },
        });

        if (!streamResult.receivedText) {
          const result = await chatService.send(nextMessages);
          finishAssistant({ content: result.response || t('chat.ready') });
        } else {
          finishAssistant();
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') return;

        try {
          const result = await chatService.send(nextMessages);
          finishAssistant({ content: result.response || t('chat.ready') });
        } catch (fallbackError: unknown) {
          finishAssistant({ content: buildFallbackMessage(fallbackError, t) });
        }
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, messages, t]
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setIsLoading(false);
  }, []);

  return { messages, isLoading, sendMessage, reset };
}
