import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { ritualsApi } from '../api'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent } from '@/shared/components/ui/card'

type Insight = Awaited<ReturnType<typeof ritualsApi.aiSummary>>

interface Props {
  instanceId: string
  /** Label for the trigger button. */
  label?: string
  /** Pre-existing snapshot payload (if ritual already has an aiSummary persisted). */
  cached?: Insight | null
  /** ISO timestamp when cached was generated. */
  cachedAt?: string | null
}

/**
 * Scoped AI summary block. Renders a trigger button; on click, fetches
 * structured insights for the ritual instance and displays them.
 * Spec §8 Phase 4: AI is always "scoped to a ritual moment".
 */
export function AiRitualSummary({ instanceId, label, cached = null, cachedAt = null }: Props) {
  const { t } = useTranslation('rituals')
  const [insight, setInsight] = useState<Insight | null>(cached)

  const summaryMut = useMutation({
    mutationFn: () => ritualsApi.aiSummary(instanceId),
    onSuccess: (data) => setInsight(data),
  })

  const loading = summaryMut.isPending
  const run = () => summaryMut.mutate()
  const triggerLabel = label ?? t('ai.generateSummary')

  if (!insight) {
    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={run}
        disabled={loading}
      >
        <Sparkles className="h-3 w-3" />
        {loading ? t('ai.analyzing') : triggerLabel}
      </Button>
    )
  }

  const staleHint =
    cachedAt && insight === cached
      ? ` · ${t('ai.cached', {
          time: new Date(cachedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }),
        })}`
      : ''

  return (
    <Card className="bg-card/60">
      <CardContent className="p-3 text-xs space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium">
            <Sparkles className="h-3 w-3 text-primary" /> {t('ai.summary')}<span className="text-muted-foreground font-normal">{staleHint}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={run}
            disabled={loading}
            className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            {loading ? t('ai.refreshing') : t('ai.rerun')}
          </Button>
        </div>
        <p className="text-sm text-foreground">{insight.summary}</p>
        {insight.highlights.length > 0 && (
          <Section label={t('ai.highlights')} items={insight.highlights} />
        )}
        {insight.blockers.length > 0 && (
          <Section label={t('ai.blockers')} items={insight.blockers} />
        )}
        <div className="border-t border-border/40 pt-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">{t('ai.nextFocus')}</div>
          <p className="text-sm font-medium">{insight.suggestedNextFocus}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function Section({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">{label}</div>
      <ul className="list-disc pl-4 space-y-0.5">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  )
}
