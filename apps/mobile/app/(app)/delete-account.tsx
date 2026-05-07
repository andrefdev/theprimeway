import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  AlertTriangle,
  ChevronRight,
  Mail,
  ShieldAlert,
  Trash2,
} from 'lucide-react-native';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Textarea } from '@/shared/components/ui/textarea';
import { Checkbox } from '@/shared/components/ui/checkbox';
import { Header } from '@/shared/components/layout/Header';
import { useTranslation } from '@/shared/hooks/useTranslation';
import { useAuthStore } from '@/shared/stores/authStore';
import { toast } from '@/shared/lib/toast';
import {
  useConfirmAccountDeletion,
  useRequestAccountDeletion,
} from '@features/settings';

type Step = 'warning' | 'reason' | 'identity' | 'otp';

const REASON_OPTIONS = [
  'not_using',
  'too_complex',
  'too_expensive',
  'privacy',
  'found_alternative',
  'temporary_break',
  'other',
] as const;

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_S = 30;

export default function DeleteAccountScreen() {
  const { t } = useTranslation('features.settings.deleteAccount');
  const user = useAuthStore((s) => s.user);

  const requestDeletion = useRequestAccountDeletion();
  const confirmDeletion = useConfirmAccountDeletion();

  const [step, setStep] = useState<Step>('warning');
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState<string>('');
  const [reasonNote, setReasonNote] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [resendCooldown, setResendCooldown] = useState(0);

  const otpInputs = useRef<(TextInput | null)[]>([]);

  const userEmail = user?.email ?? '';
  const emailMatches =
    confirmEmail.trim().length > 0 &&
    confirmEmail.trim().toLowerCase() === userEmail.toLowerCase();
  const code = otp.join('');

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  const reasonString = useMemo(() => {
    const parts: string[] = [];
    if (reason) parts.push(reason);
    if (reasonNote.trim()) parts.push(reasonNote.trim());
    if (parts.length === 0) return undefined;
    return parts.join(' — ').slice(0, 500);
  }, [reason, reasonNote]);

  function handleClose() {
    router.back();
  }

  async function sendCode() {
    if (!emailMatches) {
      toast.error(t('emailMismatch'));
      return;
    }
    try {
      await requestDeletion.mutateAsync({
        confirmEmail: confirmEmail.trim(),
        password: password || undefined,
        reason: reasonString,
      });
      setStep('otp');
      setOtp(Array(OTP_LENGTH).fill(''));
      setResendCooldown(RESEND_COOLDOWN_S);
      toast.success(t('codeSent'));
      // Focus first OTP slot
      setTimeout(() => otpInputs.current[0]?.focus(), 150);
    } catch (err: any) {
      const msg = (err?.response?.data?.error || '').toLowerCase();
      if (msg.includes('password')) toast.error(t('invalidPassword'));
      else if (msg.includes('many') || err?.response?.status === 429)
        toast.error(t('rateLimited'));
      else toast.error(t('sendFailed'));
    }
  }

  async function handleResend() {
    if (resendCooldown > 0) return;
    try {
      await requestDeletion.mutateAsync({
        confirmEmail: confirmEmail.trim(),
        password: password || undefined,
        reason: reasonString,
      });
      setOtp(Array(OTP_LENGTH).fill(''));
      setResendCooldown(RESEND_COOLDOWN_S);
      toast.success(t('codeResent'));
      setTimeout(() => otpInputs.current[0]?.focus(), 100);
    } catch (err: any) {
      if (err?.response?.status === 429) toast.error(t('rateLimited'));
      else toast.error(t('sendFailed'));
    }
  }

  async function handleConfirm() {
    if (code.length !== OTP_LENGTH) return;
    try {
      await confirmDeletion.mutateAsync(code);
      toast.success(t('deleted'));
      // Auth store cleared inside the mutation onSuccess; the (app) layout will
      // redirect to /(auth)/login on next render. Nudge in case we're stuck on
      // this screen.
      router.replace('/(auth)/login');
    } catch (err: any) {
      const msg = (err?.response?.data?.error || '').toLowerCase();
      if (msg.includes('attempts')) {
        toast.error(t('tooManyAttempts'));
        setOtp(Array(OTP_LENGTH).fill(''));
        setStep('identity');
      } else {
        toast.error(t('invalidCode'));
        setOtp(Array(OTP_LENGTH).fill(''));
        setTimeout(() => otpInputs.current[0]?.focus(), 50);
      }
    }
  }

  function handleOtpChange(text: string, index: number) {
    const sanitized = text.replace(/\D/g, '');
    if (!sanitized && otp[index]) {
      const next = [...otp];
      next[index] = '';
      setOtp(next);
      return;
    }

    // Handle paste of full code
    if (sanitized.length > 1) {
      const digits = sanitized.slice(0, OTP_LENGTH).split('');
      const next = Array(OTP_LENGTH).fill('');
      digits.forEach((d, i) => (next[i] = d));
      setOtp(next);
      const focusIdx = Math.min(digits.length, OTP_LENGTH - 1);
      otpInputs.current[focusIdx]?.focus();
      return;
    }

    const next = [...otp];
    next[index] = sanitized;
    setOtp(next);
    if (sanitized && index < OTP_LENGTH - 1) {
      otpInputs.current[index + 1]?.focus();
    }
  }

  function handleOtpKeyPress(key: string, index: number) {
    if (key === 'Backspace' && !otp[index] && index > 0) {
      otpInputs.current[index - 1]?.focus();
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <Header title={t('title')} showBack onBack={handleClose} />

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-10"
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View entering={FadeIn.duration(180)} key={step}>
          {step === 'warning' && (
            <WarningStep
              t={t}
              acknowledged={acknowledged}
              onAcknowledge={setAcknowledged}
              onCancel={handleClose}
              onNext={() => setStep('reason')}
            />
          )}

          {step === 'reason' && (
            <ReasonStep
              t={t}
              reason={reason}
              onReason={setReason}
              note={reasonNote}
              onNote={setReasonNote}
              onCancel={handleClose}
              onNext={() => setStep('identity')}
            />
          )}

          {step === 'identity' && (
            <IdentityStep
              t={t}
              userEmail={userEmail}
              email={confirmEmail}
              onEmail={setConfirmEmail}
              password={password}
              onPassword={setPassword}
              emailMatches={emailMatches}
              isPending={requestDeletion.isPending}
              onBack={() => setStep('reason')}
              onSend={sendCode}
            />
          )}

          {step === 'otp' && (
            <OtpStep
              t={t}
              userEmail={userEmail}
              otp={otp}
              inputsRef={otpInputs}
              onChange={handleOtpChange}
              onKeyPress={handleOtpKeyPress}
              onResend={handleResend}
              resendCooldown={resendCooldown}
              isResending={requestDeletion.isPending}
              isConfirming={confirmDeletion.isPending}
              codeReady={code.length === OTP_LENGTH}
              onCancel={handleClose}
              onConfirm={handleConfirm}
            />
          )}
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Step 1: Warning ──────────────────────────────────────────────────────────

function WarningStep({
  t,
  acknowledged,
  onAcknowledge,
  onCancel,
  onNext,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const losses = ['lossTasks', 'lossHabits', 'lossCalendar', 'lossGoals', 'lossSettings'];

  return (
    <View className="gap-4">
      <View className="flex-row items-center gap-2">
        <Icon as={AlertTriangle} size={22} className="text-destructive" />
        <Text className="flex-1 text-xl font-semibold text-foreground">
          {t('warningTitle')}
        </Text>
      </View>
      <Text className="text-sm text-muted-foreground">{t('warningSubtitle')}</Text>

      <View className="gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
        <Text className="text-xs font-semibold uppercase tracking-wider text-destructive">
          {t('willLose')}
        </Text>
        <View className="gap-1.5">
          {losses.map((key) => (
            <View key={key} className="flex-row items-start gap-2">
              <Text className="text-muted-foreground">•</Text>
              <Text className="flex-1 text-sm text-foreground">{t(key)}</Text>
            </View>
          ))}
        </View>
      </View>

      <Text className="text-xs text-muted-foreground">{t('irreversible')}</Text>

      <Pressable
        className="flex-row items-start gap-3 rounded-lg border border-border bg-card p-3 active:bg-muted"
        onPress={() => onAcknowledge(!acknowledged)}
      >
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(v: boolean) => onAcknowledge(v === true)}
          className="mt-0.5"
        />
        <Text className="flex-1 text-sm text-foreground">{t('ackCheckbox')}</Text>
      </Pressable>

      <View className="mt-2 flex-row gap-3">
        <Button variant="outline" className="flex-1" onPress={onCancel}>
          <Text>{t('stay')}</Text>
        </Button>
        <Button
          variant="destructive"
          className="flex-1"
          disabled={!acknowledged}
          onPress={onNext}
        >
          <Text>{t('continue')}</Text>
        </Button>
      </View>
    </View>
  );
}

// ─── Step 2: Reason ───────────────────────────────────────────────────────────

function ReasonStep({
  t,
  reason,
  onReason,
  note,
  onNote,
  onCancel,
  onNext,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  reason: string;
  onReason: (v: string) => void;
  note: string;
  onNote: (v: string) => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  return (
    <View className="gap-4">
      <Text className="text-xl font-semibold text-foreground">{t('reasonTitle')}</Text>
      <Text className="text-sm text-muted-foreground">{t('reasonSubtitle')}</Text>

      <View className="gap-2">
        {REASON_OPTIONS.map((opt) => {
          const selected = reason === opt;
          return (
            <Pressable
              key={opt}
              onPress={() => onReason(selected ? '' : opt)}
              className={
                'flex-row items-center justify-between rounded-lg border p-3 active:bg-muted ' +
                (selected ? 'border-destructive bg-destructive/10' : 'border-border bg-card')
              }
            >
              <Text
                className={
                  'flex-1 text-sm ' +
                  (selected ? 'font-medium text-destructive' : 'text-foreground')
                }
              >
                {t(`reasonOpt.${opt}`)}
              </Text>
              {selected && <Icon as={ChevronRight} size={16} className="text-destructive" />}
            </Pressable>
          );
        })}
      </View>

      <Textarea
        placeholder={t('reasonPlaceholder')}
        value={note}
        onChangeText={onNote}
        maxLength={500}
        numberOfLines={3}
      />

      {reason === 'temporary_break' && (
        <View className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <Text className="text-xs text-amber-700 dark:text-amber-400">{t('breakHint')}</Text>
        </View>
      )}

      <View className="mt-2 flex-row gap-3">
        <Button variant="outline" className="flex-1" onPress={onCancel}>
          <Text>{t('stay')}</Text>
        </Button>
        <Button variant="destructive" className="flex-1" onPress={onNext}>
          <Text>{t('continue')}</Text>
        </Button>
      </View>
    </View>
  );
}

// ─── Step 3: Identity ─────────────────────────────────────────────────────────

function IdentityStep({
  t,
  userEmail,
  email,
  onEmail,
  password,
  onPassword,
  emailMatches,
  isPending,
  onBack,
  onSend,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  userEmail: string;
  email: string;
  onEmail: (v: string) => void;
  password: string;
  onPassword: (v: string) => void;
  emailMatches: boolean;
  isPending: boolean;
  onBack: () => void;
  onSend: () => void;
}) {
  return (
    <View className="gap-4">
      <View className="flex-row items-center gap-2">
        <Icon as={ShieldAlert} size={22} className="text-destructive" />
        <Text className="flex-1 text-xl font-semibold text-foreground">
          {t('identityTitle')}
        </Text>
      </View>
      <Text className="text-sm text-muted-foreground">
        {t('identitySubtitle', { email: userEmail })}
      </Text>

      <View className="gap-1.5">
        <Text className="text-xs font-medium text-muted-foreground">{t('typeEmail')}</Text>
        <Input
          value={email}
          onChangeText={onEmail}
          placeholder={userEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
        />
      </View>

      <View className="gap-1.5">
        <Text className="text-xs font-medium text-muted-foreground">{t('password')}</Text>
        <Input
          value={password}
          onChangeText={onPassword}
          placeholder={t('passwordPlaceholder')}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
        />
        <Text className="text-2xs text-muted-foreground">{t('passwordHint')}</Text>
      </View>

      <View className="mt-2 flex-row gap-3">
        <Button variant="outline" className="flex-1" onPress={onBack}>
          <Text>{t('back')}</Text>
        </Button>
        <Button
          variant="destructive"
          className="flex-1"
          onPress={onSend}
          disabled={!emailMatches || isPending}
        >
          {isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Icon as={Mail} size={16} className="text-white" />
              <Text>{t('sendCode')}</Text>
            </>
          )}
        </Button>
      </View>
    </View>
  );
}

// ─── Step 4: OTP ──────────────────────────────────────────────────────────────

function OtpStep({
  t,
  userEmail,
  otp,
  inputsRef,
  onChange,
  onKeyPress,
  onResend,
  resendCooldown,
  isResending,
  isConfirming,
  codeReady,
  onCancel,
  onConfirm,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  userEmail: string;
  otp: string[];
  inputsRef: React.MutableRefObject<(TextInput | null)[]>;
  onChange: (text: string, index: number) => void;
  onKeyPress: (key: string, index: number) => void;
  onResend: () => void;
  resendCooldown: number;
  isResending: boolean;
  isConfirming: boolean;
  codeReady: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <View className="gap-4">
      <Text className="text-xl font-semibold text-foreground">{t('otpTitle')}</Text>
      <Text className="text-sm text-muted-foreground">
        {t('otpSubtitle', { email: userEmail })}
      </Text>

      <View className="gap-2">
        <Text className="text-xs font-medium text-muted-foreground">{t('codeLabel')}</Text>
        <View className="flex-row justify-center gap-2">
          {otp.map((digit, idx) => (
            <TextInput
              key={idx}
              ref={(ref) => {
                inputsRef.current[idx] = ref;
              }}
              className="h-14 w-12 rounded-lg border border-border bg-background text-center text-xl font-bold text-foreground"
              maxLength={idx === 0 ? OTP_LENGTH : 1}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              value={digit}
              onChangeText={(text) => onChange(text, idx)}
              onKeyPress={({ nativeEvent }) => onKeyPress(nativeEvent.key, idx)}
              autoFocus={idx === 0}
            />
          ))}
        </View>
      </View>

      <Pressable
        onPress={onResend}
        disabled={resendCooldown > 0 || isResending}
        className="self-start py-2"
        hitSlop={8}
      >
        <Text
          className={
            'text-xs ' +
            (resendCooldown > 0 || isResending
              ? 'text-muted-foreground/50'
              : 'text-primary')
          }
        >
          {resendCooldown > 0
            ? t('resendIn', { seconds: resendCooldown })
            : t('resend')}
        </Text>
      </Pressable>

      <View className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <Text className="text-xs text-destructive">{t('finalWarning')}</Text>
      </View>

      <View className="mt-2 flex-row gap-3">
        <Button variant="outline" className="flex-1" onPress={onCancel}>
          <Text>{t('cancel')}</Text>
        </Button>
        <Button
          variant="destructive"
          className="flex-1"
          onPress={onConfirm}
          disabled={!codeReady || isConfirming}
        >
          {isConfirming ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Icon as={Trash2} size={16} className="text-white" />
              <Text>{t('confirmDelete')}</Text>
            </>
          )}
        </Button>
      </View>
    </View>
  );
}
