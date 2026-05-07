import { useState } from 'react';
import { Alert, View, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { FormSheet } from '@/shared/components/ui/form-sheet';
import { Text } from '@/shared/components/ui/text';
import { Button } from '@/shared/components/ui/button';
import { useCreateHabit } from '../hooks/useHabits';
import { cn } from '@/shared/utils/cn';
import { useTranslation } from '@/shared/hooks/useTranslation';

const CATEGORIES = [
  { key: 'health', labelKey: 'categories.healthFitness', emoji: '💪' },
  { key: 'learning', labelKey: 'categories.learningDevelopment', emoji: '📚' },
  { key: 'work', labelKey: 'categories.workProductivity', emoji: '💼' },
  { key: 'mindfulness', labelKey: 'categories.mindfulnessWellbeing', emoji: '🧘' },
  { key: 'social', labelKey: 'categories.socialRelationships', emoji: '👥' },
  { key: 'creative', labelKey: 'categories.creativeHobbies', emoji: '🎨' },
  { key: 'finance', labelKey: 'categories.financeMoney', emoji: '💰' },
  { key: 'home', labelKey: 'categories.homeEnvironment', emoji: '🏠' },
];

const COLORS = ['#280FFB', '#10B981', '#8B5CF6', '#EF4444', '#F59E0B', '#EC4899', '#06B6D4', '#6366F1'];
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface HabitFormSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export function HabitFormSheet({ isOpen, onClose }: HabitFormSheetProps) {
  const { t } = useTranslation('features.habits');
  const createHabit = useCreateHabit();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('health');
  const [color, setColor] = useState('#280FFB');
  const [freqType, setFreqType] = useState('daily');
  const [weekDays, setWeekDays] = useState<number[]>([]);

  const toggleDay = (i: number) => {
    setWeekDays((prev) => prev.includes(i) ? prev.filter((d) => d !== i) : [...prev, i]);
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    try {
      await createHabit.mutateAsync({
        name: name.trim(),
        category,
        color,
        frequency_type: freqType,
        target_frequency: 1,
        week_days: freqType === 'week_days' ? weekDays : undefined,
      } as any);
      setName('');
      setCategory('health');
      setColor('#280FFB');
      setFreqType('daily');
      setWeekDays([]);
      onClose();
    } catch {
      Alert.alert(t('errors.title'), t('errors.create'));
    }
  };

  return (
    <FormSheet isOpen={isOpen} onClose={onClose} title={t('newHabit')}>
      <TextInput
        className="rounded-xl border border-border bg-card px-4 py-3.5 text-base font-medium text-foreground"
        placeholder={t('habitNamePlaceholder')}
        placeholderTextColor="hsl(210, 10%, 55%)"
        value={name}
        onChangeText={setName}
      />

      {/* Category */}
      <View>
        <Text className="mb-2 text-xs font-medium text-muted-foreground">{t('habitCategory')}</Text>
        <View className="flex-row flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <Pressable
              key={c.key}
              onPress={() => setCategory(c.key)}
              className={cn(
                'flex-row items-center gap-1.5 rounded-lg border px-3 py-2',
                category === c.key ? 'border-primary bg-primary/10' : 'border-border bg-card'
              )}
            >
              <Text className="text-sm">{c.emoji}</Text>
              <Text className={cn('text-xs font-medium', category === c.key ? 'text-primary' : 'text-muted-foreground')}>
                {t(c.labelKey)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Color */}
      <View>
        <Text className="mb-2 text-xs font-medium text-muted-foreground">{t('habitColor')}</Text>
        <View className="flex-row gap-3">
          {COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => setColor(c)}
              className={cn('h-8 w-8 rounded-full', color === c && 'border-2 border-foreground')}
              style={{ backgroundColor: c }}
            />
          ))}
        </View>
      </View>

      {/* Frequency */}
      <View>
        <Text className="mb-2 text-xs font-medium text-muted-foreground">{t('frequency.label')}</Text>
        <View className="flex-row gap-2">
          {['daily', 'week_days'].map((f) => (
            <Pressable
              key={f}
              onPress={() => setFreqType(f)}
              className={cn(
                'flex-1 items-center rounded-xl border py-2.5',
                freqType === f ? 'border-primary bg-primary/10' : 'border-border bg-card'
              )}
            >
              <Text className={cn('text-sm font-medium', freqType === f ? 'text-primary' : 'text-muted-foreground')}>
                {f === 'daily' ? t('frequency.dailyLabel') : t('frequency.weekDaysLabel')}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {freqType === 'week_days' && (
        <View className="flex-row justify-between">
          {DAYS.map((d, i) => (
            <Pressable
              key={`${d}-${i}`}
              onPress={() => toggleDay(i)}
              className={cn(
                'h-10 w-10 items-center justify-center rounded-full',
                weekDays.includes(i) ? 'bg-primary' : 'bg-muted'
              )}
            >
              <Text className={cn('text-sm font-medium', weekDays.includes(i) ? 'text-primary-foreground' : 'text-muted-foreground')}>
                {d}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <Button className="h-12 rounded-xl" onPress={handleSubmit} disabled={createHabit.isPending || !name.trim()}>
        {createHabit.isPending ? (
          <ActivityIndicator size="small" color="white" />
        ) : (
          <Text className="text-sm font-bold text-primary-foreground">{t('actions.create')}</Text>
        )}
      </Button>
    </FormSheet>
  );
}
