import { useState } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/shared/components/ui/text';
import { Icon } from '@/shared/components/ui/icon';
import {
  Wrench,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  CircleCheck,
  CircleX,
  CircleAlert,
} from 'lucide-react-native';

export type ToolCallState = 'call' | 'result' | 'partial-call';

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  state: ToolCallState;
  result?: unknown;
}

const LABELS: Record<string, { title: string; verb: string }> = {
  // reads
  listTasks: { title: 'Looked up tasks', verb: '' },
  listHabits: { title: 'Looked up habits', verb: '' },
  listGoals: { title: 'Looked up goals', verb: '' },
  listCalendarEvents: { title: 'Checked calendar', verb: '' },
  findFreeSlots: { title: 'Searched free slots', verb: '' },
  // writes
  createTask: { title: 'Create task', verb: 'Create' },
  updateTask: { title: 'Update task', verb: 'Update' },
  deleteTask: { title: 'Delete task', verb: 'Delete' },
  completeTask: { title: 'Complete task', verb: 'Mark done' },
  createHabit: { title: 'Create habit', verb: 'Create' },
  updateHabit: { title: 'Update habit', verb: 'Update' },
  logHabit: { title: 'Log habit today', verb: 'Log' },
  createGoal: { title: 'Create goal', verb: 'Create' },
  updateGoalProgress: { title: 'Update goal progress', verb: 'Update' },
  createTimeBlock: { title: 'Schedule time block', verb: 'Schedule' },
  updateCalendarEvent: { title: 'Update calendar event', verb: 'Update' },
  deleteCalendarEvent: { title: 'Delete calendar event', verb: 'Delete' },
  startPomodoro: { title: 'Start pomodoro', verb: 'Start' },
  saveBrainIdea: { title: 'Save idea to brain', verb: 'Save' },
};

const READ_ONLY_TOOLS = new Set([
  'listTasks',
  'listHabits',
  'listGoals',
  'listCalendarEvents',
  'findFreeSlots',
]);

function extractErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (typeof r.error === 'string') return r.error;
  if (r.error && typeof r.error === 'object') {
    const e = r.error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
  }
  if (typeof r.message === 'string' && r.success === false) return r.message;
  return null;
}

interface ToolCallCardProps {
  toolCall: ToolCall;
  onAccept?: () => Promise<void> | void;
  onReject?: () => void;
  isBusy?: boolean;
}

export function ToolCallCard({ toolCall, onAccept, onReject, isBusy }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const label = LABELS[toolCall.toolName] ?? { title: toolCall.toolName, verb: 'Run' };

  const isClientTool = !READ_ONLY_TOOLS.has(toolCall.toolName);
  const isResolved = toolCall.state === 'result';
  const isPending = toolCall.state === 'call' || toolCall.state === 'partial-call';
  const needsConfirmation = isClientTool && isPending && !!onAccept && !!onReject;

  const result = toolCall.result;
  const wasRejected =
    isResolved && !!result && typeof result === 'object' && (result as { rejected?: boolean }).rejected === true;
  const errorMessage = isResolved ? extractErrorMessage(result) : null;
  const resultStatus: 'success' | 'rejected' | 'error' | null = isResolved
    ? wasRejected
      ? 'rejected'
      : errorMessage
        ? 'error'
        : 'success'
    : null;

  const StatusIcon =
    resultStatus === 'success'
      ? CircleCheck
      : resultStatus === 'rejected'
        ? CircleX
        : resultStatus === 'error'
          ? CircleAlert
          : null;

  return (
    <View className="mt-2 overflow-hidden rounded-xl border border-primary/20 bg-primary/5">
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        className="flex-row items-center gap-2 px-3 py-2 active:bg-primary/10"
      >
        <Icon as={Wrench} size={12} className="text-primary" />
        <Text className="flex-1 text-xs font-semibold text-primary">{label.title}</Text>
        {StatusIcon && (
          <Icon
            as={StatusIcon}
            size={14}
            className={
              resultStatus === 'success'
                ? 'text-emerald-500'
                : resultStatus === 'rejected'
                  ? 'text-muted-foreground'
                  : 'text-destructive'
            }
          />
        )}
        <Icon
          as={expanded ? ChevronDown : ChevronRight}
          size={12}
          className="text-primary/60"
        />
      </Pressable>

      {needsConfirmation && (
        <View className="flex-row gap-2 border-t border-primary/10 px-3 py-2">
          <Pressable
            onPress={() => {
              if (!isBusy) onReject?.();
            }}
            disabled={isBusy}
            className="flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 active:bg-muted"
          >
            <Icon as={X} size={14} className="text-muted-foreground" />
            <Text className="text-xs font-medium text-muted-foreground">Reject</Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              if (!isBusy) await onAccept?.();
            }}
            disabled={isBusy}
            className="flex-1 flex-row items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 active:bg-primary/90"
          >
            {isBusy ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Icon as={Check} size={14} className="text-primary-foreground" />
            )}
            <Text className="text-xs font-medium text-primary-foreground">
              {isBusy ? '…' : label.verb || 'Run'}
            </Text>
          </Pressable>
        </View>
      )}

      {expanded && (
        <View className="gap-2 border-t border-primary/10 px-3 pb-3 pt-2">
          {Object.keys(toolCall.args).length > 0 && (
            <View>
              <Text className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Input
              </Text>
              <Text className="font-mono text-xs text-muted-foreground">
                {JSON.stringify(toolCall.args, null, 2)}
              </Text>
            </View>
          )}
          {isResolved && (
            <View>
              <Text className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                {errorMessage ? 'Error' : wasRejected ? 'Rejected' : 'Result'}
              </Text>
              <Text
                className={
                  errorMessage
                    ? 'font-mono text-xs text-destructive'
                    : 'font-mono text-xs text-foreground'
                }
              >
                {errorMessage
                  ? errorMessage
                  : typeof result === 'string'
                    ? result
                    : JSON.stringify(result, null, 2)}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
