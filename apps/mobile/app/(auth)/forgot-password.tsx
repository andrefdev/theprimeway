import { View, TextInput, Alert } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/shared/components/ui/text';
import { Button } from '@/shared/components/ui/button';
import { useState } from 'react';
import { authService } from '@features/auth';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from '@/shared/hooks/useTranslation';

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const { t } = useTranslation('auth.forgotPassword');
  const { t: tCommon } = useTranslation('common');

  const handleSubmit = async () => {
    if (!email) return;
    setIsLoading(true);
    try {
      await authService.requestOtp(email);
      setSent(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('error');
      Alert.alert(tCommon('status.error'), message);
    } finally {
      setIsLoading(false);
    }
  };

  if (sent) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-2xl font-bold text-foreground">{t('sentTitle')}</Text>
          <Text className="mt-2 text-center text-muted-foreground">
            {t('sentDescription', { email })}
          </Text>
          <Button className="mt-8" onPress={() => router.replace('/(auth)/login')}>
            <Text className="text-sm font-medium text-primary-foreground">{t('backToLogin')}</Text>
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center px-6">
        <Text className="text-center text-2xl font-bold text-foreground">{t('title')}</Text>
        <Text className="mt-2 text-center text-muted-foreground">
          {t('description')}
        </Text>

        <View className="mt-8 gap-2">
          <Text className="text-sm font-medium text-foreground">{t('email')}</Text>
          <TextInput
            className="h-11 rounded-md border border-input bg-background px-3 text-base text-foreground"
            placeholder={t('emailPlaceholder')}
            placeholderTextColor="hsl(0 0% 63.9%)"
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
          />
        </View>

        <Button className="mt-6" onPress={handleSubmit} disabled={isLoading}>
          <Text className="text-sm font-medium text-primary-foreground">
            {isLoading ? t('sending') : t('submit')}
          </Text>
        </Button>

        <Button variant="ghost" className="mt-4" onPress={() => router.back()}>
          <Text className="text-sm text-muted-foreground">{t('backToLogin')}</Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
