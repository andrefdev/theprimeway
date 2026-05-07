import { useMemo } from 'react'
import { useWorkingHoursOverride } from '../queries'
import { useWorkingHours } from '@/features/working-hours/queries'
import { useUserTimezone } from '@/features/settings/hooks/use-user-timezone'
import { localDayOfWeek, ymdToLocalDayUtc } from '@repo/shared/utils'

export interface EffectiveDayBounds {
  startHour: number
  endHour: number
  source: 'override' | 'weekly' | 'fallback'
  hasOverride: boolean
  isWorkingDay: boolean
}

const FALLBACK: { startHour: number; endHour: number } = { startHour: 9, endHour: 17 }

function parseHHMM(value: string, fallback: number): number {
  const [h, m] = value.split(':').map(Number)
  return (h ?? fallback) + (m ?? 0) / 60
}

/**
 * Resolves the effective working-hours window for a local YYYY-MM-DD.
 * Mirrors the backend precedence in `gap-finder.getEffectiveWorkingHours`:
 *   per-date override > weekly schedule > fallback (9-17).
 *
 * `dayKey` must be a local "YYYY-MM-DD" (same convention as TasksToday).
 */
export function useEffectiveDayBounds(dayKey: string): EffectiveDayBounds {
  const tz = useUserTimezone()
  const overrideQuery = useWorkingHoursOverride(dayKey)
  const weeklyQuery = useWorkingHours()

  return useMemo(() => {
    const o = overrideQuery.data
    if (o) {
      return {
        startHour: parseHHMM(o.startTime, 9),
        endHour: parseHHMM(o.endTime, 17),
        source: 'override',
        hasOverride: true,
        isWorkingDay: true,
      }
    }
    const dow = localDayOfWeek(ymdToLocalDayUtc(dayKey, tz), tz)
    const weekly = (weeklyQuery.data ?? []).find(
      (r) => r.channelId == null && r.dayOfWeek === dow,
    )
    if (weekly) {
      return {
        startHour: parseHHMM(weekly.startTime, 9),
        endHour: parseHHMM(weekly.endTime, 17),
        source: 'weekly',
        hasOverride: false,
        isWorkingDay: true,
      }
    }
    return {
      startHour: FALLBACK.startHour,
      endHour: FALLBACK.endHour,
      source: 'fallback',
      hasOverride: false,
      isWorkingDay: false,
    }
  }, [dayKey, tz, overrideQuery.data, weeklyQuery.data])
}
