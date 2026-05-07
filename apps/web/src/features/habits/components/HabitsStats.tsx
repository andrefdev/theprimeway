import { useQuery } from '@tanstack/react-query'
import { habitsQueries } from '../queries'
import { Card, CardContent } from '@/shared/components/ui/card'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/shared/components/ui/select'
import { SkeletonList } from '@/shared/components/ui/skeleton-list'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HabitHeatMap } from './HabitHeatMap'
import { HabitCorrelations } from './HabitCorrelations'
import { HabitAiSuggestions } from './HabitAiSuggestions'
import { HabitStacking } from './HabitStacking'

const PERIOD_OPTIONS = [
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
  { value: 'quarter', label: '90 days' },
]

export function HabitsStats() {
  const { t } = useTranslation('habits')
  const [period, setPeriod] = useState('month')
  const statsQuery = useQuery(habitsQueries.stats(period))
  const stats = statsQuery.data

  if (statsQuery.isLoading) return <SkeletonList lines={3} />

  if (!stats) return null

  const chartData = (stats.dailyProgress ?? []).map((d) => ({
    date: d.date.slice(5), // MM-DD
    rate: Math.round(d.completionRate),
  }))

  const currentStreaks = [...(stats.streaks?.current ?? [])].sort((a, b) => b.currentStreak - a.currentStreak).slice(0, 5)

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{t('statsTitle')}</h3>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="max-w-30">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{Math.round(stats.completionRate)}%</p>
            <p className="text-[10px] text-muted-foreground">{t('completionRate')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{stats.totalHabits}</p>
            <p className="text-[10px] text-muted-foreground">{t('activeHabits')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{stats.totalCompletedToday}</p>
            <p className="text-[10px] text-muted-foreground">{t('doneToday')}</p>
          </CardContent>
        </Card>
      </div>

      {/* Heat map */}
      <HabitHeatMap data={stats.dailyProgress ?? []} />

      {/* Completion rate chart */}
      {chartData.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground mb-3">{t('completionOverTime')}</p>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
                  tickLine={false}
                  width={30}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-popover)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="rate"
                  stroke="var(--color-primary)"
                  fill="var(--color-primary)"
                  fillOpacity={0.1}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Top streaks */}
      {currentStreaks.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground mb-3">{t('topStreaks')}</p>
            <div className="space-y-2">
              {currentStreaks.map((s, i) => (
                <div key={s.habitId} className="flex items-center justify-between">
                  <span className="text-sm text-foreground">
                    #{i + 1}
                  </span>
                  <span
                    className={`text-sm font-bold ${
                      s.currentStreak >= 10 ? 'text-success' : s.currentStreak >= 5 ? 'text-primary' : 'text-muted-foreground'
                    }`}
                  >
                    {s.currentStreak} {t('days')}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* AI Insights */}
      <HabitCorrelations />
      <HabitAiSuggestions />
      <HabitStacking />
    </div>
  )
}
