import { useState } from 'react';
import { Alert, View, Pressable, Platform, ActivityIndicator } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { FormSheet } from '@/shared/components/ui/form-sheet';
import { Text } from '@/shared/components/ui/text';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Icon } from '@/shared/components/ui/icon';
import { Calendar, Clock, Sparkles } from 'lucide-react-native';
import { useCreateTask } from '../hooks/useTasks';
import { cn } from '@/shared/utils/cn';
import { format } from 'date-fns';
import { VoiceInputButton } from '@features/ai';

const DURATIONS = [15, 30, 45, 60, 90, 120];
const PRIORITIES = [
  { value: 'low' as const, label: 'Low', color: 'bg-priority-low' },
  { value: 'medium' as const, label: 'Medium', color: 'bg-priority-medium' },
  { value: 'high' as const, label: 'High', color: 'bg-priority-high' },
];

interface TaskFormSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TaskFormSheet({ isOpen, onClose }: TaskFormSheetProps) {
  const createTask = useCreateTask();
  const todayStr = format(new Date(), 'yyyy-MM-dd');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [scheduledDate, setScheduledDate] = useState(todayStr);
  const [duration, setDuration] = useState(30);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const parsedDate = new Date(scheduledDate + 'T12:00:00');

  const handleSubmit = async () => {
    if (!title.trim()) return;
    try {
      await createTask.mutateAsync({
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        scheduledDate,
        estimatedDurationMinutes: duration,
        tags: [],
        isAllDay: false,
      } as any);
      setTitle('');
      setDescription('');
      setPriority('medium');
      setDuration(30);
      onClose();
    } catch {
      Alert.alert('Error', 'Could not create task');
    }
  };

  return (
    <FormSheet isOpen={isOpen} onClose={onClose} title="New Task">
      {/* Title */}
      <View className="flex-row items-center gap-2">
        <Input
          className="flex-1 h-auto rounded-xl py-3.5 text-base font-medium"
          placeholder="What do you need to do?"
          placeholderTextColor="hsl(210, 10%, 55%)"
          value={title}
          onChangeText={setTitle}
        />
        <VoiceInputButton
          size={40}
          onInterim={(text) => setTitle(text)}
          onTranscript={(text) => setTitle(text)}
        />
      </View>

      {/* Date + Duration */}
      <View className="flex-row gap-3">
        <Pressable
          onPress={() => setShowDatePicker(true)}
          className="flex-1 flex-row items-center gap-2 rounded-xl border border-border bg-card px-3 py-3"
        >
          <Icon as={Calendar} size={16} className="text-primary" />
          <Text className="text-sm text-foreground">{format(parsedDate, 'MMM d, yyyy')}</Text>
        </Pressable>
        <View className="flex-row items-center gap-2 rounded-xl border border-border bg-card px-3 py-3">
          <Icon as={Clock} size={16} className="text-muted-foreground" />
          <Text className="text-sm text-foreground">{duration}m</Text>
        </View>
      </View>

      {showDatePicker && (
        <DateTimePicker
          value={parsedDate}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(_, date) => {
            setShowDatePicker(Platform.OS === 'ios');
            if (date) setScheduledDate(format(date, 'yyyy-MM-dd'));
          }}
        />
      )}

      {/* Duration presets */}
      <View>
        <Text className="mb-2 text-xs font-medium text-muted-foreground">Duration</Text>
        <View className="flex-row flex-wrap gap-2">
          {DURATIONS.map((d) => (
            <Pressable
              key={d}
              onPress={() => setDuration(d)}
              className={cn(
                'rounded-lg border px-3 py-1.5',
                duration === d ? 'border-primary bg-primary/10' : 'border-border bg-card'
              )}
            >
              <Text className={cn('text-xs font-medium', duration === d ? 'text-primary' : 'text-muted-foreground')}>
                {d >= 60 ? `${d / 60}h` : `${d}m`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Auto-schedule */}
      <View className="flex-row items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
        <Icon as={Sparkles} size={16} className="text-primary" />
        <View className="flex-1">
          <Text className="text-xs font-semibold text-primary">Auto-schedule</Text>
          <Text className="text-2xs text-muted-foreground">Best slot will be found for you</Text>
        </View>
      </View>

      {/* Priority */}
      <View>
        <Text className="mb-2 text-xs font-medium text-muted-foreground">Priority</Text>
        <View className="flex-row gap-2">
          {PRIORITIES.map((p) => (
            <Pressable
              key={p.value}
              onPress={() => setPriority(p.value)}
              className={cn(
                'flex-1 items-center rounded-xl border py-2.5',
                priority === p.value ? `${p.color} border-transparent` : 'border-border bg-card'
              )}
            >
              <Text className={cn('text-sm font-medium', priority === p.value ? 'text-white' : 'text-muted-foreground')}>
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Description */}
      <Input
        className="min-h-[70px] h-auto rounded-xl py-3 text-sm"
        placeholder="Add details..."
        placeholderTextColor="hsl(210, 10%, 55%)"
        multiline
        textAlignVertical="top"
        value={description}
        onChangeText={setDescription}
      />

      {/* Submit */}
      <Button className="h-12 rounded-xl" onPress={handleSubmit} disabled={createTask.isPending || !title.trim()}>
        {createTask.isPending ? (
          <ActivityIndicator size="small" color="white" />
        ) : (
          <Text className="text-sm font-bold text-primary-foreground">Create Task</Text>
        )}
      </Button>
    </FormSheet>
  );
}
