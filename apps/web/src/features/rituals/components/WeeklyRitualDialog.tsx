import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { PromptRitualDialog } from './PromptRitualDialog'
import { AiRitualSummary } from './AiRitualSummary'
import { useAddReflection, useUpdateRitualInstance } from '../queries'
import { goalsApi } from '@/features/goals/api'
import { ritualsApi, type RitualInstance } from '../api'
import { Sparkles } from 'lucide-react'
import { localYmd } from '@repo/shared/utils'
import { useUserTimezone } from '@/features/settings/hooks/use-user-timezone'

interface Props {
  instance: RitualInstance
  open: boolean
  onClose: () => void
}

function mondayOfWeekInTz(d: Date, tz: string): string {
  // Anchor on the user's local day, then walk back to Monday.
  const todayKey = localYmd(d, tz)
  const [y, m, day] = todayKey.split('-').map(Number)
  const local = new Date(y!, (m! - 1), day!)
  const dow = local.getDay()
  local.setDate(local.getDate() - ((dow + 6) % 7))
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
}

/**
 * Weekly Plan — 2 steps:
 *   1. Vision check-in (reflection prompt)
 *   2. Pick 3–5 weekly objectives → creates Goal{horizon: WEEK}
 */
export function WeeklyPlanDialog({ instance, open, onClose }: Props) {
  const { t } = useTranslation('rituals')
  const tz = useUserTimezone()
  const [phase, setPhase] = useState<'checkin' | 'objectives' | 'done'>('checkin')
  const [checkin, setCheckin] = useState('')
  const [objectives, setObjectives] = useState<string[]>(['', '', ''])
  const [creating, setCreating] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [rationale, setRationale] = useState<string | null>(null)
  const qc = useQueryClient()
  const inputsRef = useRef<Array<HTMLInputElement | null>>([])
  const [pendingFocus, setPendingFocus] = useState<number | null>(null)

  useEffect(() => {
    if (pendingFocus != null) {
      inputsRef.current[pendingFocus]?.focus()
      setPendingFocus(null)
    }
  }, [pendingFocus, objectives.length])

  function handleObjectiveKeyDown(e: React.KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (i + 1 < objectives.length) {
        inputsRef.current[i + 1]?.focus()
      } else if (objectives.length < 5) {
        setObjectives((prev) => [...prev, ''])
        setPendingFocus(i + 1)
      }
    } else if (e.key === 'Backspace' && objectives[i] === '' && objectives.length > 1) {
      e.preventDefault()
      const target = Math.max(0, i - 1)
      setObjectives((prev) => prev.filter((_, idx) => idx !== i))
      setPendingFocus(target)
    }
  }

  async function suggestObjectives() {
    setSuggesting(true)
    try {
      const r = await ritualsApi.suggestWeeklyObjectives(instance.id)
      setObjectives(r.objectives.slice(0, 5).concat(Array(Math.max(0, 3 - r.objectives.length)).fill('')))
      setRationale(r.rationale)
    } catch (err) {
      toast.error((err as Error).message || t('weeklyPlan.aiSuggestionFailed'))
    } finally {
      setSuggesting(false)
    }
  }

  const updateInstance = useUpdateRitualInstance()
  const addReflection = useAddReflection()

  useEffect(() => {
    if (open) {
      setPhase('checkin')
      setCheckin('')
      // Pre-fill from cached AI suggestion if present.
      const cached = (instance.snapshot as any)?.aiSuggestedObjectives as
        | { objectives: string[]; rationale: string }
        | undefined
      if (cached?.objectives?.length) {
        setObjectives(cached.objectives.slice(0, 5).concat(Array(Math.max(0, 3 - cached.objectives.length)).fill('')))
        setRationale(cached.rationale)
      } else {
        setObjectives(['', '', ''])
        setRationale(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, instance.id])

  async function advance() {
    if (checkin.trim()) {
      try {
        await addReflection.mutateAsync({ ritualInstanceId: instance.id, promptKey: 'vision_checkin', body: checkin.trim() })
      } catch (err) {
        toast.error((err as Error).message || t('weeklyPlan.failedToSaveRitual'))
        return
      }
    }
    setPhase('objectives')
  }

  function updateObjective(i: number, value: string) {
    setObjectives((prev) => {
      const next = [...prev]
      next[i] = value
      return next
    })
  }
  function addObjective() {
    if (objectives.length < 5) setObjectives([...objectives, ''])
  }
  function removeObjective(i: number) {
    setObjectives((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function savePlan() {
    const titles = objectives.map((o) => o.trim()).filter(Boolean)
    if (titles.length === 0) {
      // No objectives — just complete with reflection only.
      await finalize(0)
      return
    }
    setCreating(true)
    const weekStartDate = mondayOfWeekInTz(new Date(), tz)
    let created = 0
    let failed = 0
    let lastError: unknown = null
    for (const title of titles) {
      try {
        await goalsApi.createWeeklyGoal({ weekStartDate, title, status: 'planned' } as any)
        created++
      } catch (err) {
        failed++
        lastError = err
      }
    }
    qc.invalidateQueries({ queryKey: ['goals'] })
    setCreating(false)
    if (created > 0) toast.success(t('weeklyPlan.createdObjectives', { count: created }))
    if (failed > 0) {
      const detail = lastError instanceof Error ? lastError.message : ''
      toast.error(detail ? `${t('weeklyPlan.failedToSave', { count: failed })}: ${detail}` : t('weeklyPlan.failedToSave', { count: failed }))
    }
    if (created === 0 && failed > 0) {
      // Don't mark the ritual as completed if nothing got saved.
      return
    }
    await finalize(created)
  }

  async function finalize(objectivesCreated: number) {
    try {
      await updateInstance.mutateAsync({
        id: instance.id,
        body: {
          status: 'COMPLETED',
          completedAt: new Date().toISOString(),
          snapshot: { vision_checkin: checkin.trim() || null, objectivesCreated, objectives: objectives.filter(Boolean) },
        },
      })
      toast.success(t('weeklyPlan.completeToast'))
    } catch (err) {
      toast.error((err as Error).message || t('weeklyPlan.failedToComplete'))
      return
    }
    onClose()
  }

  async function skip() {
    try {
      await updateInstance.mutateAsync({ id: instance.id, body: { status: 'SKIPPED' } })
      onClose()
    } catch {
      /* ignore */
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('weeklyPlan.title')}</DialogTitle>
          <DialogDescription>
            {phase === 'checkin' ? t('weeklyPlan.stepCheckin') : t('weeklyPlan.stepObjectives')}
          </DialogDescription>
        </DialogHeader>

        {phase === 'checkin' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('weeklyPlan.checkinHint')}
            </p>
            <textarea
              autoFocus
              rows={4}
              value={checkin}
              onChange={(e) => setCheckin(e.target.value)}
              placeholder={t('weeklyPlan.checkinPlaceholder')}
              className="w-full rounded-md border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={skip}>{t('buttons.skip')}</Button>
              <Button onClick={advance} disabled={addReflection.isPending}>{t('buttons.next')}</Button>
            </div>
          </div>
        )}

        {phase === 'objectives' && (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-muted-foreground flex-1">
                {t('weeklyPlan.objectivesHint')}
              </p>
              <button
                type="button"
                onClick={suggestObjectives}
                disabled={suggesting}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs hover:bg-accent/40 disabled:opacity-60 whitespace-nowrap"
              >
                <Sparkles className="h-3 w-3" />
                {suggesting ? t('weeklyPlan.thinking') : t('weeklyPlan.suggestWithAi')}
              </button>
            </div>
            {rationale && (
              <div className="rounded-md border border-border bg-card/60 p-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t('weeklyPlan.aiRationale')}</span> {rationale}
              </div>
            )}
            <div className="space-y-2">
              {objectives.map((val, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-5 text-xs text-muted-foreground text-right tabular-nums">{i + 1}.</span>
                  <Input
                    ref={(el) => { inputsRef.current[i] = el }}
                    value={val}
                    onChange={(e) => updateObjective(i, e.target.value)}
                    onKeyDown={(e) => handleObjectiveKeyDown(e, i)}
                    placeholder={t('weeklyPlan.objectivePlaceholder')}
                    className="h-9"
                  />
                  {objectives.length > 1 && (
                    <Button variant="ghost" size="sm" className="px-2 text-muted-foreground hover:text-destructive" onClick={() => removeObjective(i)}>
                      ✕
                    </Button>
                  )}
                </div>
              ))}
              {objectives.length < 5 && (
                <Button variant="ghost" size="sm" onClick={addObjective} className="text-xs text-muted-foreground">
                  {t('weeklyPlan.addObjective')}
                </Button>
              )}
            </div>
            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" size="sm" onClick={() => setPhase('checkin')} disabled={creating}>{t('buttons.back')}</Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => finalize(0)} disabled={creating}>
                  {t('weeklyPlan.skip')}
                </Button>
                <Button onClick={savePlan} disabled={creating}>
                  {creating ? t('weeklyPlan.saving') : t('weeklyPlan.savePlan')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function WeeklyReviewDialog({ instance, open, onClose }: Props) {
  const { t } = useTranslation('rituals')
  const tz = useUserTimezone()
  const weekStart = mondayOfWeekInTz(new Date(instance.scheduledFor), tz)
  const alignmentQuery = useQuery({
    queryKey: ['goals', 'weekly-alignment', weekStart],
    queryFn: () => goalsApi.weeklyAlignment(weekStart),
    enabled: open,
    staleTime: 30_000,
  })
  const a = alignmentQuery.data
  const tone = !a ? 'muted' : a.alignmentPct >= 70 ? 'good' : a.alignmentPct >= 40 ? 'warn' : 'bad'
  const toneClass =
    tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'bad' ? 'text-rose-600 dark:text-rose-400'
    : 'text-muted-foreground'

  return (
    <PromptRitualDialog
      instance={instance}
      open={open}
      onClose={onClose}
      title={t('weeklyReview.title')}
      hint={
        <div className="space-y-2">
          <p>{t('weeklyReview.hint')}</p>
          {a && a.total > 0 && (
            <div className="rounded-md bg-muted/40 p-3 text-xs space-y-2">
              <div>
                {t('weeklyReview.alignment')}{' '}
                <span className={`font-semibold tabular-nums ${toneClass}`}>{a.alignmentPct}%</span>{' '}
                <span className="text-muted-foreground">
                  {t('weeklyReview.alignmentDetail', { aligned: a.aligned, total: a.total })}
                </span>
              </div>
              {a.unaligned > 0 && a.sampleUnaligned.length > 0 && (
                <div className="text-muted-foreground">
                  {t('weeklyReview.unalignedSample', {
                    sample:
                      a.sampleUnaligned.slice(0, 3).join(', ') +
                      (a.sampleUnaligned.length > 3 ? '…' : ''),
                  })}
                </div>
              )}
            </div>
          )}
          {a && a.total === 0 && (
            <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
              {t('weeklyReview.noCompletedTasks')}
            </div>
          )}
          <AiRitualSummary
            instanceId={instance.id}
            cached={(instance.snapshot as any)?.aiSummary ?? null}
            cachedAt={(instance.snapshot as any)?.aiSummaryAt ?? null}
          />
        </div>
      }
    />
  )
}
