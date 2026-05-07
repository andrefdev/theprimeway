import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckIcon,
  XIcon,
  ChevronDown,
  ChevronRight,
  Loader2,
  CircleCheck,
  CircleX,
  CircleAlert,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { cn } from '@/shared/lib/utils'

interface ToolCallCardProps {
  toolName: string
  args: Record<string, unknown>
  state: 'call' | 'result' | 'partial-call'
  result?: unknown
  onAccept?: () => Promise<void> | void
  onReject?: () => void
  isBusy?: boolean
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
}

const READ_ONLY_TOOLS = new Set([
  'listTasks',
  'listHabits',
  'listGoals',
  'listCalendarEvents',
  'findFreeSlots',
])

function extractErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (typeof r.error === 'string') return r.error
  if (r.error && typeof r.error === 'object') {
    const e = r.error as Record<string, unknown>
    if (typeof e.message === 'string') return e.message
  }
  if (typeof r.message === 'string' && r.success === false) return r.message
  return null
}

export function ToolCallCard({
  toolName,
  args,
  state,
  result,
  onAccept,
  onReject,
  isBusy,
}: ToolCallCardProps) {
  const { t } = useTranslation('ai')
  const [error, setError] = useState<string | null>(null)
  const label = LABELS[toolName] ?? { title: toolName, verb: 'Run' }

  const isClientTool = !READ_ONLY_TOOLS.has(toolName)
  const isResolved = state === 'result'
  const isPending = state === 'call' || state === 'partial-call'
  const needsConfirmation = isClientTool && isPending

  const resultStatus: 'success' | 'rejected' | 'error' | null = isResolved
    ? (result as any)?.rejected
      ? 'rejected'
      : (result as any)?.error || (result as any)?.success === false
        ? 'error'
        : 'success'
    : null

  const errorReason = resultStatus === 'error' ? extractErrorMessage(result) : null

  // Read-only resolved tools: collapse by default. Pending or error tools: expand by default.
  const [expanded, setExpanded] = useState(needsConfirmation || resultStatus === 'error')
  const hasArgs = Object.keys(args).length > 0
  const isCollapsible = !needsConfirmation && hasArgs

  async function handleAccept() {
    setError(null)
    try {
      await onAccept?.()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to execute action')
    }
  }

  return (
    <Card
      className={cn(
        'rounded-xl border bg-muted/30 px-3 py-2 text-sm shadow-none',
        resultStatus === 'success' && 'border-emerald-500/30 bg-emerald-500/5',
        resultStatus === 'rejected' && 'border-muted bg-muted/30',
        resultStatus === 'error' && 'border-destructive/40 bg-destructive/5',
      )}
    >
      <button
        type="button"
        onClick={() => isCollapsible && setExpanded((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 text-left',
          isCollapsible && 'cursor-pointer',
        )}
        disabled={!isCollapsible}
        aria-expanded={expanded}
      >
        <StatusIcon status={resultStatus} pending={isPending} />
        <span className="flex-1 truncate text-xs font-medium text-foreground">
          {label.title}
        </span>
        {resultStatus && (
          <span
            className={cn(
              'text-[10px] font-medium uppercase tracking-wide',
              resultStatus === 'success' && 'text-emerald-600 dark:text-emerald-400',
              resultStatus === 'rejected' && 'text-muted-foreground',
              resultStatus === 'error' && 'text-destructive',
            )}
          >
            {resultStatus === 'success' && 'Applied'}
            {resultStatus === 'rejected' && 'Cancelled'}
            {resultStatus === 'error' && 'Failed'}
          </span>
        )}
        {isCollapsible && (
          <span className="text-muted-foreground">
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
        )}
      </button>

      {expanded && hasArgs && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t pt-2 text-[11px]">
          {Object.entries(args).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-words text-foreground/90">{formatValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {resultStatus === 'error' && (
        <p className="mt-2 text-xs text-destructive">
          {errorReason ?? t('toolFailed')}
        </p>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {needsConfirmation && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={handleAccept} disabled={isBusy}>
            <CheckIcon className="size-3.5" /> {label.verb}
          </Button>
          <Button size="sm" variant="ghost" onClick={onReject} disabled={isBusy}>
            <XIcon className="size-3.5" /> Reject
          </Button>
        </div>
      )}
    </Card>
  )
}

function StatusIcon({
  status,
  pending,
}: {
  status: 'success' | 'rejected' | 'error' | null
  pending: boolean
}) {
  if (pending) return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  if (status === 'success') return <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
  if (status === 'rejected') return <CircleX className="size-3.5 shrink-0 text-muted-foreground" />
  if (status === 'error') return <CircleAlert className="size-3.5 shrink-0 text-destructive" />
  return null
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
