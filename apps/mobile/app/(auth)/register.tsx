import { View, ScrollView, Alert } from 'react-native';
import { Link, router } from 'expo-router';
import { Text } from '@/shared/components/ui/text';
import { RegisterForm } from '@features/auth';
import { SocialButton } from '@features/auth';
import { useAuth } from '@features/auth';
import { useState } from 'react';
import type { RegisterFormData } from '@features/auth';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from '@/shared/hooks/useTranslation';

export default function RegisterScreen() {
  const { register } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation('auth.register');
  const { t: tCommon } = useTranslation('common');
  const { t: tLogin } = useTranslation('auth.login');

  const handleRegister = async (data: RegisterFormData) => {
    setIsLoading(true);
    try {
      await register(data);
      router.replace('/(app)/(tabs)');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('errorTitle');
      Alert.alert(tCommon('status.error'), message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="flex-grow justify-center px-6 py-8"
        keyboardShouldPersistTaps="handled"
      >
        <View className="mb-8">
          <Text className="text-center text-3xl font-bold text-foreground">{t('title')}</Text>
          <Text className="mt-2 text-center text-muted-foreground">
            {t('description')}
          </Text>
        </View>

        <RegisterForm onSubmit={handleRegister} isLoading={isLoading} />

        <View className="my-6 flex-row items-center gap-4">
          <View className="h-px flex-1 bg-border" />
          <Text className="text-xs text-muted-foreground">{tCommon('actions.or')}</Text>
          <View className="h-px flex-1 bg-border" />
        </View>

        <View className="gap-3">
          <SocialButton provider="google" onPress={() => {}} />
          <SocialButton provider="apple" onPress={() => {}} />
        </View>

        <View className="mt-8 flex-row items-center justify-center gap-1">
          <Text className="text-sm text-muted-foreground">{t('hasAccount')}</Text>
          <Link href="/(auth)/login" asChild>
            <Text className="text-sm font-medium text-primary">{tLogin('title')}</Text>
          </Link>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
