import { useState, useEffect } from 'react';
import { Alert, View, TextInput, Pressable, Platform, ActivityIndicator } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { FormSheet } from '@/shared/components/ui/form-sheet';
import { Text } from '@/shared/components/ui/text';
import { Button } from '@/shared/components/ui/button';
import { Icon } from '@/shared/components/ui/icon';
import { Calendar, Clock, Trash2 } from 'lucide-react-native';
import { useUpdateTask, useDeleteTask } from '../hooks/useTasks';
import { cn } from '@/shared/utils/cn';
import { format } from 'date-fns';
import type { Task } from '@shared/types/models';
import { SubtaskList } from './SubtaskList';
import { deleteAllSubtasks } from '../services/localSubtasks';

const DURATIONS = [15, 30, 45, 60, 90, 120];
const PRIORITIES = [
  { value: 'low' as const, label: 'Low', color: 'bg-priority-low' },
  { value: 'medium' as const, label: 'Medium', color: 'bg-priority-medium' },
  { value: 'high' as const, label: 'High', color: 'bg-priority-high' },
];

interface TaskEditSheetProps {
  task: Task | null;
  isOpen: boolean;
  onClose: () => void;
}

export function TaskEditSheet({ task, isOpen, onClose }: TaskEditSheetProps) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [scheduledDate, setScheduledDate] = useState('');
  const [duration, setDuration] = useState(30);
  const [showDatePicker, setShowDatePicker] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? '');
      setPriority(task.priority);
      setScheduledDate(task.scheduledDate?.split('T')[0] ?? format(new Date(), 'yyyy-MM-dd'));
      setDuration(task.estimatedDurationMinutes ?? 30);
    }
  }, [task]);

  const parsedDate = scheduledDate ? new Date(scheduledDate + 'T12:00:00') : new Date();

  const handleUpdate = async () => {
    if (!task || !title.trim()) return;
    try {
      await updateTask.mutateAsync({
        id: task.id,
        data: {
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
          scheduledDate,
          estimatedDurationMinutes: duration,
        } as any,
      });
      onClose();
    } catch {
      Alert.alert('Error', 'Could not update task');
    }
  };

  const handleDelete = () => {
    if (!task) return;
    Alert.alert('Delete Task', 'Are you sure you want to delete this task?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteTask.mutateAsync(task.id);
          await deleteAllSubtasks(task.id);
          onClose();
        },
      },
    ]);
  };

  return (
    <FormSheet isOpen={isOpen} onClose={onClose} title="Edit Task">
      <TextInput
        className="rounded-xl border border-border bg-card px-4 py-3.5 text-base font-medium text-foreground"
        placeholder="Task title"
        placeholderTextColor="hsl(210, 10%, 55%)"
        value={title}
        onChangeText={setTitle}
      />

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

      <View>
        <Text className="mb-2 text-xs font-medium text-muted-foreground">Duration</Text>
        <View className="flex-row flex-wrap gap-2">
          {DURATIONS.map((d) => (
            <Pressable
              key={d}
              onPress={() => setDuration(d)}
              className={cn('rounded-lg border px-3 py-1.5', duration === d ? 'border-primary bg-primary/10' : 'border-border bg-card')}
            >
              <Text className={cn('text-xs font-medium', duration === d ? 'text-primary' : 'text-muted-foreground')}>
                {d >= 60 ? `${d / 60}h` : `${d}m`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View>
        <Text className="mb-2 text-xs font-medium text-muted-foreground">Priority</Text>
        <View className="flex-row gap-2">
          {PRIORITIES.map((p) => (
            <Pressable
              key={p.value}
              onPress={() => setPriority(p.value)}
              className={cn('flex-1 items-center rounded-xl border py-2.5', priority === p.value ? `${p.color} border-transparent` : 'border-border bg-card')}
            >
              <Text className={cn('text-sm font-medium', priority === p.value ? 'text-white' : 'text-muted-foreground')}>{p.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <TextInput
        className="min-h-[70px] rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground"
        placeholder="Add details..."
        placeholderTextColor="hsl(210, 10%, 55%)"
        multiline
        textAlignVertical="top"
        value={description}
        onChangeText={setDescription}
      />

      {/* Subtasks */}
      {task && <SubtaskList taskId={task.id} />}

      <Button className="h-12 rounded-xl" onPress={handleUpdate} disabled={updateTask.isPending || !title.trim()}>
        {updateTask.isPending ? (
          <ActivityIndicator size="small" color="white" />
        ) : (
          <Text className="text-sm font-bold text-primary-foreground">Update Task</Text>
        )}
      </Button>

      <Button variant="ghost" onPress={handleDelete} className="h-11">
        <Icon as={Trash2} size={16} className="text-destructive" />
        <Text className="text-sm font-medium text-destructive">Delete Task</Text>
      </Button>
    </FormSheet>
  );
}
