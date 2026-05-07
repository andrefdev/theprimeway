import { apiClient } from '@shared/api/client';
import { AI } from '@shared/api/endpoints';
import { useAuthStore } from '@shared/stores/authStore';
import type { ChatMessageData } from '../components/ChatMessage';
import type { ToolCall } from '../components/ToolCallCard';

export interface ChatPayloadMessage {
  role: 'user' | 'assistant';
  content: string;
}

type StreamChunk =
  | { type: 'text-delta'; delta?: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input?: Record<string, unknown> }
  | { type: 'tool-output-available'; toolCallId: string; output?: unknown }
  | { type: 'error'; error?: string }
  | { type: string };

function isTextDelta(chunk: StreamChunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> {
  return chunk.type === 'text-delta';
}

function isToolInput(
  chunk: StreamChunk
): chunk is Extract<StreamChunk, { type: 'tool-input-available' }> {
  return chunk.type === 'tool-input-available' && 'toolCallId' in chunk && 'toolName' in chunk;
}

function isToolOutput(
  chunk: StreamChunk
): chunk is Extract<StreamChunk, { type: 'tool-output-available' }> {
  return chunk.type === 'tool-output-available' && 'toolCallId' in chunk;
}

function isStreamError(chunk: StreamChunk): chunk is Extract<StreamChunk, { type: 'error' }> {
  return chunk.type === 'error';
}

interface StreamHandlers {
  signal: AbortSignal;
  messages: ChatMessageData[];
  onDelta: (delta: string) => void;
  onToolCalls: (toolCalls: ToolCall[]) => void;
}

export class ChatRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ChatRequestError';
  }
}

function apiUrl(path: string) {
  const base = process.env.EXPO_PUBLIC_API_URL;
  if (!base) throw new ChatRequestError('EXPO_PUBLIC_API_URL is not configured');
  return `${base.replace(/\/$/, '')}${path}`;
}

type UiMessagePart =
  | { type: 'text'; text: string }
  | { type: 'file'; mediaType: string; data: string }
  | {
      type: string;
      toolCallId: string;
      state: 'output-available';
      input: Record<string, unknown>;
      output: unknown;
    };

function toUiMessages(messages: ChatMessageData[]) {
  return messages.map((message) => {
    const parts: UiMessagePart[] = [];

    if (message.attachments && message.attachments.length > 0) {
      for (const att of message.attachments) {
        if (!att.base64) continue;
        parts.push({
          type: 'file',
          mediaType: att.mediaType,
          data: `data:${att.mediaType};base64,${att.base64}`,
        });
      }
    }

    if (message.content) {
      parts.push({ type: 'text', text: message.content });
    }

    // For assistant messages, replay any resolved tool calls so the model has
    // full conversation context (including client-side accept/reject results)
    // when continuing the stream.
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      for (const tc of message.toolCalls) {
        if (tc.state !== 'result') continue;
        parts.push({
          type: `tool-${tc.toolName}`,
          toolCallId: tc.toolCallId,
          state: 'output-available',
          input: tc.args ?? {},
          output: tc.result ?? null,
        });
      }
    }

    if (parts.length === 0) {
      parts.push({ type: 'text', text: '' });
    }

    return {
      id: message.id,
      role: message.role,
      parts,
    };
  });
}

function toPayloadMessages(messages: ChatPayloadMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

async function readError(response: Response) {
  try {
    const body = await response.json();
    return body?.error ?? body?.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export const chatService = {
  async stream({ signal, messages, onDelta, onToolCalls }: StreamHandlers) {
    const token = useAuthStore.getState().token;
    const response = await fetch(apiUrl(`${AI.CHAT}/stream`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages: toUiMessages(messages) }),
      signal,
    });

    if (!response.ok) {
      throw new ChatRequestError(await readError(response), response.status);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new ChatRequestError('Streaming is unavailable on this device');

    const decoder = new TextDecoder();
    const toolCallsById = new Map<string, ToolCall>();
    let buffer = '';
    let receivedText = false;

    const flushToolCalls = () => onToolCalls(Array.from(toolCallsById.values()));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(raw) as StreamChunk;
        } catch {
          continue;
        }

        if (isTextDelta(chunk)) {
          const delta = chunk.delta ?? '';
          if (delta) {
            receivedText = true;
            onDelta(delta);
          }
        } else if (isToolInput(chunk)) {
          toolCallsById.set(chunk.toolCallId, {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            args: chunk.input ?? {},
            state: 'call',
          });
          flushToolCalls();
        } else if (isToolOutput(chunk)) {
          const existing = toolCallsById.get(chunk.toolCallId);
          if (existing) {
            toolCallsById.set(chunk.toolCallId, {
              ...existing,
              state: 'result',
              result: chunk.output,
            });
            flushToolCalls();
          }
        } else if (isStreamError(chunk)) {
          throw new ChatRequestError(chunk.error ?? 'Stream error');
        }
      }
    }

    return { receivedText };
  },

  async send(messages: ChatPayloadMessage[]) {
    const { data } = await apiClient.post<{ response: string; toolResults?: unknown[] }>(
      AI.CHAT,
      { messages: toPayloadMessages(messages) }
    );
    return data;
  },
};
