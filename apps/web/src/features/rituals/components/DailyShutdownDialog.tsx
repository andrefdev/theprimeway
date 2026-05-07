import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/components/ui/button'
import { toast } from 'sonner'
import { tasksApi } from '@/features/tasks/api'
import { tasksQueries } from '@/features/tasks/queries'
import { PromptRitualDialog } from './PromptRitualDialog'
import { AiRitualSummary } from './AiRitualSummary'
import { FatigueSignal } from '@/features/fatigue/components/FatigueSignal'
import type { RitualInstance } from '../api'
import type { Task } from '@repo/shared/types'

interface Props {
  instance: RitualInstance
  open: boolean
  onClose: () => void
}

function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function DailyShutdownDialog({ instance, open, onClose }: Props) {
  const { t } = useTranslation('rituals')
  const today = toYMD(new Date())
  const tomorrowDate = new Date()
  tomorrowDate.setDate(tomorrowDate.getDate() + 1)
  const tomorrow = toYMD(tomorrowDate)

  const tasksQuery = useQuery(tasksQueries.today(today))
  const openTasks = useMemo(
    () => ((tasksQuery.data?.data ?? []) as Task[]).filter((t) => t.status === 'open'),
    [tasksQuery.data],
  )

  const qc = useQueryClient()
  const [rolling, setRolling] = useState(false)
  const [rolledIds, setRolledIds] = useState<Set<string>>(new Set())

  async function rolloverAll(taskList: Task[], complete: (snapshot?: unknown) => Promise<void>) {
    setRolling(true)
    let moved = 0
    let failed = 0
    let lastError: unknown = null
    for (const t of taskList) {
      try {
        await tasksApi.update(t.id, {
          scheduledDate: tomorrow,
          scheduledStart: null,
          scheduledEnd: null,
          scheduledBucket: 'TOMORROW',
        })
        moved++
        setRolledIds((s) => new Set(s).add(t.id))
      } catch (err) {
        failed++
        lastError = err
      }
    }
    qc.invalidateQueries({ queryKey: ['tasks'] })
    qc.invalidateQueries({ queryKey: ['working-sessions'] })
    setRolling(false)
    if (moved > 0) toast.success(`Rolled ${moved} task${moved === 1 ? '' : 's'} to tomorrow`)
    if (failed > 0) {
      const detail = lastError instanceof Error ? lastError.message : ''
      toast.error(detail ? `${failed} failed to roll over: ${detail}` : `${failed} failed to roll over`)
      return
    }
    await complete({ rolledOver: moved, skippedRollover: failed })
  }

  return (
    <PromptRitualDialog
      instance={instance}
      open={open}
      onClose={onClose}
      title={t('dailyShutdown.title', { defaultValue: 'Daily Shutdown' })}
      hint={
        <div className="space-y-2">
          <p>{t('dailyShutdown.hint', { defaultValue: "Close the day cleanly. Reflect, then roll over what's left." })}</p>
          <FatigueSignal variant="inline" />
          <AiRitualSummary
            instanceId={instance.id}
            label={t('dailyShutdown.summarize', { defaultValue: 'Summarize my day' })}
            cached={(instance.snapshot as any)?.aiSummary ?? null}
            cachedAt={(instance.snapshot as any)?.aiSummaryAt ?? null}
          />
        </div>
      }
      finalStep={({ complete, back }) => {
        const remaining = openTasks.filter((t) => !rolledIds.has(t.id))
        return (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {remaining.length === 0
                ? t('dailyShutdown.allDone', { defaultValue: 'No open tasks left for today. Clean shutdown.' })
                : t('dailyShutdown.rollPrompt', { count: remaining.length, defaultValue: '{{count}} open tasks still on today. Roll them to tomorrow?' })}
            </p>
            {remaining.length > 0 && (
              <ul className="max-h-48 overflow-y-auto space-y-1 pr-1 rounded-md border border-border/40 bg-muted/10 p-2">
                {remaining.map((t) => (
                  <li key={t.id} className="text-sm px-2 py-1 break-words">
                    {t.title}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between pt-1">
              <Button variant="ghost" size="sm" onClick={back} disabled={rolling}>{t('buttons.back', { defaultValue: 'Back' })}</Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => complete({ rolledOver: 0 })} disabled={rolling}>
                  {t('dailyShutdown.skipRollover', { defaultValue: 'Skip rollover' })}
                </Button>
                {remaining.length > 0 && (
                  <Button onClick={() => rolloverAll(remaining, complete)} disabled={rolling}>
                    {rolling
                      ? t('dailyShutdown.rolling', { defaultValue: 'Rolling…' })
                      : t('dailyShutdown.rollAndFinish', { count: remaining.length, defaultValue: 'Roll over {{count}} & finish' })}
                  </Button>
                )}
                {remaining.length === 0 && (
                  <Button onClick={() => complete({ rolledOver: 0 })} disabled={rolling}>{t('buttons.finish', { defaultValue: 'Finish' })}</Button>
                )}
              </div>
            </div>
          </div>
        )
      }}
    />
  )
}
