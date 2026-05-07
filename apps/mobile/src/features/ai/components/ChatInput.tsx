import { useState } from 'react';
import { View, TextInput, Pressable, Image, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Icon } from '@/shared/components/ui/icon';
import { Plus, Send, X } from 'lucide-react-native';
import { cn } from '@/shared/utils/cn';
import { useTranslation } from '@/shared/hooks/useTranslation';
import { VoiceInputButton } from './VoiceInputButton';
import type { ChatAttachment } from './ChatMessage';

const MAX_ATTACHMENTS = 4;

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: (text?: string, attachments?: ChatAttachment[]) => void;
  disabled?: boolean;
  voiceLang?: string;
}

function createAttachmentId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function inferMediaType(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.mimeType) return asset.mimeType;
  const ext = asset.fileName?.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

export function ChatInput({ value, onChange, onSend, disabled, voiceLang }: Props) {
  const { t } = useTranslation('features.ai');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [pickerBusy, setPickerBusy] = useState(false);

  const canSend = (!!value.trim() || attachments.length > 0) && !disabled;

  const handleSend = () => {
    if (!canSend) return;
    onSend(value, attachments);
    setAttachments([]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handlePickImage = async () => {
    if (pickerBusy) return;
    if (attachments.length >= MAX_ATTACHMENTS) {
      Alert.alert(t('attachments.limitTitle'), t('attachments.limitMessage', { count: MAX_ATTACHMENTS }));
      return;
    }
    setPickerBusy(true);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(t('attachments.permissionTitle'), t('attachments.permissionMessage'));
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
        base64: true,
        allowsMultipleSelection: true,
        selectionLimit: MAX_ATTACHMENTS - attachments.length,
      });
      if (result.canceled) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const next: ChatAttachment[] = result.assets
        .filter((a) => !!a.base64)
        .map((a) => ({
          id: createAttachmentId(),
          uri: a.uri,
          mediaType: inferMediaType(a),
          base64: a.base64 ?? undefined,
        }));
      setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
    } finally {
      setPickerBusy(false);
    }
  };

  return (
    <View className="border-t border-border/60 bg-background/95 px-4 py-3">
      {attachments.length > 0 && (
        <View className="mb-2 flex-row flex-wrap gap-2">
          {attachments.map((att) => (
            <View key={att.id} className="relative">
              <Image
                source={{ uri: att.uri }}
                className="rounded-xl"
                style={{ width: 64, height: 64 }}
                resizeMode="cover"
              />
              <Pressable
                onPress={() => removeAttachment(att.id)}
                hitSlop={8}
                className="absolute -right-1.5 -top-1.5 h-5 w-5 items-center justify-center rounded-full bg-foreground"
              >
                <Icon as={X} size={12} className="text-background" />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      <View className="flex-row items-end gap-2">
        <Pressable
          onPress={handlePickImage}
          disabled={pickerBusy}
          className="h-11 w-11 items-center justify-center rounded-full border border-border/70 bg-card active:opacity-70"
        >
          <Icon as={Plus} size={18} className="text-muted-foreground" />
        </Pressable>
        <View className="min-h-[44px] flex-1 flex-row items-center rounded-full border border-border/70 bg-card px-4 shadow-sm shadow-black/5">
          <TextInput
            className="max-h-24 flex-1 py-2.5 text-sm text-foreground"
            placeholder={t('askAnything')}
            placeholderTextColor="hsl(210, 10%, 55%)"
            value={value}
            onChangeText={onChange}
            multiline
            onSubmitEditing={handleSend}
          />
        </View>
        <VoiceInputButton
          size={44}
          lang={voiceLang}
          onInterim={(text) => onChange(text)}
          onTranscript={(text) => {
            onChange('');
            onSend(text, attachments);
            setAttachments([]);
          }}
        />
        <Pressable
          className={cn(
            'h-11 w-11 items-center justify-center rounded-full',
            canSend ? 'bg-primary active:bg-primary-hover' : 'bg-muted'
          )}
          onPress={handleSend}
          disabled={!canSend}
        >
          <Icon
            as={Send}
            size={16}
            className={canSend ? 'text-primary-foreground' : 'text-muted-foreground'}
          />
        </Pressable>
      </View>
    </View>
  );
}
