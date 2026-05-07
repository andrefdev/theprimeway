import { SafeAreaView } from 'react-native-safe-area-context';
import { ChatPanel } from '@features/ai/components/ChatPanel';

export default function AiChatScreen() {
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ChatPanel />
    </SafeAreaView>
  );
}
