import { useQuery } from '@tanstack/react-query'
import { settingsApi } from '@/features/settings/api'
import { useWorkingSessionsForDay } from '../queries'
import { useEffectiveDayBounds } from '../hooks/use-effective-day-bounds'
import type { Task } from '@repo/shared/types'

interface Props {
  /** yyyy-mm-dd */
  day: string
  /** Open tasks for the day (scheduled + unscheduled). Used to count unscheduled planned time. */
  tasks: Task[]
}

const DEFAULT_THRESHOLD = 420
const DEFAULT_DURATION = 30

export function WorkloadCounter({ day, tasks }: Props) {
  const settingsQuery = useQuery({
    queryKey: ['user-settings'],
    queryFn: () => settingsApi.getSettings().then((r) => r.data.data),
    staleTime: 60_000,
  })
  const sessionsQuery = useWorkingSessionsForDay(day)
  const bounds = useEffectiveDayBounds(day)

  const dayMinutes =
    bounds.source === 'fallback'
      ? null
      : Math.round((bounds.endHour - bounds.startHour) * 60)

  const threshold =
    dayMinutes ?? settingsQuery.data?.workloadThresholdMinutes ?? DEFAULT_THRESHOLD
  const defaultDuration = settingsQuery.data?.defaultTaskDurationMinutes ?? DEFAULT_DURATION

  const sessions = sessionsQuery.data ?? []
  const scheduledMinutes = sessions
    .filter((s) => s.kind === 'WORK')
    .reduce(
      (sum, s) => sum + Math.round((new Date(s.end).getTime() - new Date(s.start).getTime()) / 60_000),
      0,
    )

  const scheduledTaskIds = new Set(sessions.filter((s) => s.taskId).map((s) => s.taskId!))
  const unscheduledMinutes = tasks
    .filter((t) => t.status === 'open' && !scheduledTaskIds.has(t.id))
    .reduce((sum, t) => {
      const planned = (t as any).plannedTimeMinutes ?? (t as any).estimatedDurationMinutes ?? defaultDuration
      return sum + planned
    }, 0)

  const total = scheduledMinutes + unscheduledMinutes
  const pct = Math.round((total / threshold) * 100)
  const tone = total > threshold ? 'over' : total > threshold * 0.85 ? 'near' : 'under'

  const toneClasses: Record<typeof tone, string> = {
    under: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    near: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
    over: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30',
  }

  const label = `${formatMinutes(total)} / ${formatMinutes(threshold)}`

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium tabular-nums ${toneClasses[tone]}`}
      title={`Scheduled ${formatMinutes(scheduledMinutes)} · Unscheduled ${formatMinutes(unscheduledMinutes)} · ${pct}% of threshold`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          tone === 'under' ? 'bg-emerald-500' : tone === 'near' ? 'bg-amber-500' : 'bg-rose-500'
        }`}
      />
      {label}
    </span>
  )
}

function formatMinutes(total: number): string {
  if (total < 60) return `${total}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}
