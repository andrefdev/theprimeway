import { createFileRoute, notFound } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Sparkles } from 'lucide-react'
import { Card, CardContent } from '@/shared/components/ui/card'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import {
  useRitualsList,
  useRitualsToday,
  useRitualsWeek,
  useRitualsQuarter,
  useRitualsYear,
  useUpdateRitualInstance,
} from '@/features/rituals/queries'
import type { RitualInstance, RitualKind } from '@/features/rituals/api'
import { DailyPlanDialog } from '@/features/rituals/components/DailyPlanDialog'
import { DailyShutdownDialog } from '@/features/rituals/components/DailyShutdownDialog'
import { WeeklyPlanDialog, WeeklyReviewDialog } from '@/features/rituals/components/WeeklyRitualDialog'
import { PeriodReviewDialog } from '@/features/rituals/components/PeriodReviewDialog'
import { AiRitualSummary } from '@/features/rituals/components/AiRitualSummary'
import { SectionHeader } from '@/shared/components/SectionHeader'
import { RitualsNav } from '@/features/rituals/components/RitualsNav'

const SLUG_TO_KIND: Record<string, RitualKind> = {
  'daily-plan': 'DAILY_PLAN',
  'daily-shutdown': 'DAILY_SHUTDOWN',
  'weekly-plan': 'WEEKLY_PLAN',
  'weekly-review': 'WEEKLY_REVIEW',
  'quarterly-review': 'QUARTERLY_REVIEW',
  'annual-review': 'ANNUAL_REVIEW',
}

export const Route = createFileRoute('/_app/rituals/$kind')({
  beforeLoad: ({ params }) => {
    if (!(params.kind in SLUG_TO_KIND)) throw notFound()
  },
  component: RitualKindPage,
})

function RitualKindPage() {
  const { kind: slug } = Route.useParams()
  const kind = SLUG_TO_KIND[slug]
  if (!kind) return null

  return <BuiltInShell kind={kind} />
}

function Header({ kind }: { kind: RitualKind }) {
  const { t } = useTranslation('rituals')
  return (
    <>
      <RitualsNav />
      <SectionHeader
        sectionId="rituals"
        title={t(`kinds.${kind}.title`)}
        description={t(`kinds.${kind}.description`)}
      />
    </>
  )
}

function BuiltInShell({ kind }: { kind: RitualKind }) {
  const { t } = useTranslation('rituals')
  const today = useRitualsToday()
  const week = useRitualsWeek()
  const quarter = useRitualsQuarter()
  const year = useRitualsYear()
  const ritualsList = useRitualsList()
  const updateInstance = useUpdateRitualInstance()
  const [open, setOpen] = useState(false)

  let instance: RitualInstance | undefined
  let pending: RitualInstance[] = []
  let periodLabel: string | undefined

  if (kind === 'DAILY_PLAN') {
    instance = today.data?.plan
    pending = today.data?.pending?.filter((p) => p.ritual.kind === 'DAILY_PLAN') ?? []
  } else if (kind === 'DAILY_SHUTDOWN') {
    instance = today.data?.shutdown
    pending = today.data?.pending?.filter((p) => p.ritual.kind === 'DAILY_SHUTDOWN') ?? []
  } else if (kind === 'WEEKLY_PLAN') {
    instance = week.data?.plan
    pending = week.data?.pending?.filter((p) => p.ritual.kind === 'WEEKLY_PLAN') ?? []
  } else if (kind === 'WEEKLY_REVIEW') {
    instance = week.data?.review
    pending = week.data?.pending?.filter((p) => p.ritual.kind === 'WEEKLY_REVIEW') ?? []
  } else if (kind === 'QUARTERLY_REVIEW') {
    instance = quarter.data?.review
    periodLabel = quarter.data?.periodKey
  } else if (kind === 'ANNUAL_REVIEW') {
    instance = year.data?.review
    periodLabel = year.data?.periodKey
  }

  const ritualMeta = (ritualsList.data ?? []).find((r) => r.kind === kind)
  const isLoading = today.isLoading || week.isLoading || quarter.isLoading || year.isLoading
  const isCompleted = instance?.status === 'COMPLETED'

  async function handleStart() {
    if (!instance) return
    if (instance.status === 'PENDING') {
      await updateInstance.mutateAsync({ id: instance.id, body: { status: 'IN_PROGRESS', startedAt: new Date().toISOString() } })
    }
    setOpen(true)
  }

  return (
    <div>
      <Header kind={kind} />
      <div className="mx-auto max-w-5xl px-6 pt-4 pb-6 space-y-6">
      {/* Status + actions */}
      <Card>
        <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">{t('kindPage.currentLabel')}</span>
              {periodLabel && <Badge variant="outline">{periodLabel}</Badge>}
              {instance && (
                <Badge variant={isCompleted ? 'secondary' : 'default'}>
                  {instance.status}
                </Badge>
              )}
              {!isLoading && !instance && <Badge variant="outline">{t('status.notScheduled')}</Badge>}
            </div>
            {ritualMeta?.scheduledTime && (
              <p className="text-xs text-muted-foreground">{t('kindPage.scheduledTime', { time: ritualMeta.scheduledTime })}</p>
            )}
            {instance?.completedAt && (
              <p className="text-xs text-muted-foreground">
                {t('kindPage.completedAt', { time: new Date(instance.completedAt).toLocaleString() })}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={handleStart} disabled={!instance || updateInstance.isPending}>
              <Play className="h-4 w-4 mr-2" />
              {isCompleted ? t('buttons.open') : t('buttons.start')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* AI summary (post-completion) */}
      {instance && isCompleted && (
        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">{t('sections.aiSummary')}</h2>
            </div>
            <AiRitualSummary instanceId={instance.id} />
          </CardContent>
        </Card>
      )}

      {/* Pending other instances of same kind */}
      {pending.length > 0 && (
        <Card>
          <CardContent className="p-5 space-y-3">
            <h2 className="text-sm font-semibold">{t('sections.pending')}</h2>
            <ul className="space-y-2 text-sm">
              {pending.map((p) => (
                <li key={p.id} className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                  <span>{new Date(p.scheduledFor).toLocaleString()}</span>
                  <Badge variant="outline">{p.status}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Reflection history */}
      {instance && instance.reflections.length > 0 && (
        <Card>
          <CardContent className="p-5 space-y-3">
            <h2 className="text-sm font-semibold">{t('sections.reflections')}</h2>
            <ul className="space-y-3 text-sm">
              {instance.reflections.map((r) => (
                <li key={r.id} className="rounded-md border border-border/50 p-3">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{r.promptKey}</div>
                  <div className="whitespace-pre-wrap">{r.body}</div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Dialog dispatch */}
      {instance && open && kind === 'DAILY_PLAN' && (
        <DailyPlanDialog instance={instance} open={open} onClose={() => setOpen(false)} />
      )}
      {instance && open && kind === 'DAILY_SHUTDOWN' && (
        <DailyShutdownDialog instance={instance} open={open} onClose={() => setOpen(false)} />
      )}
      {instance && open && kind === 'WEEKLY_PLAN' && (
        <WeeklyPlanDialog instance={instance} open={open} onClose={() => setOpen(false)} />
      )}
      {instance && open && kind === 'WEEKLY_REVIEW' && (
        <WeeklyReviewDialog instance={instance} open={open} onClose={() => setOpen(false)} />
      )}
      {instance && open && kind === 'QUARTERLY_REVIEW' && (
        <PeriodReviewDialog
          instance={instance}
          open={open}
          onClose={() => setOpen(false)}
          title={t('kinds.QUARTERLY_REVIEW.title')}
          periodLabel={periodLabel ?? ''}
        />
      )}
      {instance && open && kind === 'ANNUAL_REVIEW' && (
        <PeriodReviewDialog
          instance={instance}
          open={open}
          onClose={() => setOpen(false)}
          title={t('kinds.ANNUAL_REVIEW.title')}
          periodLabel={periodLabel ?? ''}
        />
      )}
      </div>
    </div>
  )
}
