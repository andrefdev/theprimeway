import { useMemo } from 'react';
import * as Localization from 'expo-localization';
import type { ChatMessageData } from '../components/ChatMessage';

const SPANISH_HINTS = /[¿¡ñáéíóúü]|\b(qué|cómo|dónde|por qué|cuándo|cuál|hola|gracias|hace|hacer|estoy|tengo|quiero|hoy|mañana|ahora|porfa|vale)\b/i;
const ENGLISH_HINTS = /\b(what|how|where|why|when|which|hello|thanks|today|tomorrow|now|please|the|and|with|for|from)\b/i;

function pickFromHistory(messages: ChatMessageData[]): 'es' | 'en' | null {
  const lastUserText = [...messages]
    .reverse()
    .filter((m) => m.role === 'user')
    .slice(0, 3)
    .map((m) => m.content)
    .join(' ');
  if (!lastUserText) return null;
  const es = SPANISH_HINTS.test(lastUserText);
  const en = ENGLISH_HINTS.test(lastUserText);
  if (es && !en) return 'es';
  if (en && !es) return 'en';
  return null;
}

function deviceLanguageTag(): string {
  const locales = Localization.getLocales();
  const tag = locales[0]?.languageTag;
  if (tag) return tag;
  const code = locales[0]?.languageCode;
  if (code === 'es') return 'es-ES';
  return 'en-US';
}

export function useSpeechLang(messages: ChatMessageData[] = []): string {
  return useMemo(() => {
    const fromHistory = pickFromHistory(messages);
    const deviceTag = deviceLanguageTag();
    if (!fromHistory) return deviceTag;
    if (fromHistory === 'es') {
      return deviceTag.startsWith('es') ? deviceTag : 'es-ES';
    }
    return deviceTag.startsWith('en') ? deviceTag : 'en-US';
  }, [messages]);
}
