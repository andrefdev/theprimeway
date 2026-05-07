import { View, TextInput, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Text } from '@/shared/components/ui/text';
import { Button } from '@/shared/components/ui/button';
import { useState, useRef } from 'react';
import { authService } from '@features/auth';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from '@/shared/hooks/useTranslation';

const OTP_LENGTH = 6;

export default function VerifyOtpScreen() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [isLoading, setIsLoading] = useState(false);
  const inputs = useRef<(TextInput | null)[]>([]);
  const { t } = useTranslation('auth.otp');
  const { t: tCommon } = useTranslation('common');

  const handleChange = (text: string, index: number) => {
    const newOtp = [...otp];
    newOtp[index] = text;
    setOtp(newOtp);

    if (text && index < OTP_LENGTH - 1) {
      inputs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (key: string, index: number) => {
    if (key === 'Backspace' && !otp[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  const handleVerify = async () => {
    const code = otp.join('');
    if (code.length !== OTP_LENGTH) return;

    setIsLoading(true);
    try {
      await authService.verifyOtp(email || '', code);
      router.replace('/(app)/(tabs)');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('error');
      Alert.alert(tCommon('status.error'), message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center px-6">
        <Text className="text-center text-2xl font-bold text-foreground">{t('title')}</Text>
        <Text className="mt-2 text-center text-muted-foreground">
          {t('helper')}
        </Text>

        <View className="mt-8 flex-row justify-center gap-3">
          {otp.map((digit, index) => (
            <TextInput
              key={index}
              ref={(ref) => {
                inputs.current[index] = ref;
              }}
              className="h-14 w-12 rounded-lg border border-border bg-background text-center text-xl font-bold text-foreground"
              maxLength={1}
              keyboardType="number-pad"
              value={digit}
              onChangeText={(text) => handleChange(text, index)}
              onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, index)}
              autoFocus={index === 0}
            />
          ))}
        </View>

        <Button className="mt-8" onPress={handleVerify} disabled={isLoading}>
          <Text className="text-sm font-medium text-primary-foreground">
            {isLoading ? t('verifying') : t('verify')}
          </Text>
        </Button>

        <Button variant="ghost" className="mt-4" onPress={() => router.back()}>
          <Text className="text-sm text-muted-foreground">{t('backToLogin')}</Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
