/**
 * Recurring task instance generation.
 *
 * A "recurring parent" is a Task with `isRecurring=true` and a
 * `recurrenceRule` ('daily' | 'weekly' | 'monthly' | 'weekdays' |
 * `custom:MO,WE,FR`). Once per day a cron hits `processRecurringTasks`
 * for each user; for every parent whose rule fires today, we create a
 * fresh child instance scheduled for today and link it back via
 * `recurringParentId`.
 *
 * Why not just one row that recurs visually? Each occurrence is its own
 * task — completable, schedulable, time-trackable — and we want history
 * (each completed instance is a fact). Generating instances on demand
 * (lazy) keeps the row count bounded to "what the user has actually
 * seen" instead of pre-materializing 365 daily rows.
 *
 * Timezone handling: all "is today a firing day?" math is done in the
 * user's local timezone. Using `getUTCDay()` / `getUTCDate()` directly
 * on a moment-in-time gives the wrong answer near day boundaries for
 * non-UTC users — that's the bug fixed here vs the previous
 * implementation in tasks.service.ts.
 */
import { tasksRepository } from '../../repositories/tasks.repo'
import { prisma } from '../../lib/prisma'
import { localDayOfWeek, localYmd } from '@repo/shared/utils'
import type { Task } from '@prisma/client'

type TaskModel = Task & { weeklyGoal?: unknown }

const DAY_LETTER_TO_INDEX: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
}

/**
 * Calculate the next occurrence date based on a recurrence rule and
 * reference date. Returns a Date — caller is responsible for slicing
 * to YYYY-MM-DD if it wants the bucket-date form.
 *
 * Note: arithmetic uses UTC components. After the 2026-05-07
 * scheduledDate normalization, the reference Date will be UTC-midnight
 * of the user's local Y-M-D, so adding N days in UTC keeps it on the
 * user's local Y-M-D + N. Pre-migration callers passing a raw
 * timestamp would skew here — the reconcile script ran already so this
 * isn't a live concern.
 */
export function getNextOccurrenceDate(rule: string, fromDate: Date): Date {
  const next = new Date(fromDate)

  if (rule === 'daily') {
    next.setUTCDate(next.getUTCDate() + 1)
  } else if (rule === 'weekly') {
    next.setUTCDate(next.getUTCDate() + 7)
  } else if (rule === 'monthly') {
    next.setUTCMonth(next.getUTCMonth() + 1)
  } else if (rule === 'weekdays') {
    // Advance to the next weekday (Mon-Fri).
    do {
      next.setUTCDate(next.getUTCDate() + 1)
    } while (next.getUTCDay() === 0 || next.getUTCDay() === 6)
  } else if (rule.startsWith('custom:')) {
    // e.g. "custom:MO,WE,FR"
    const allowedDays = rule
      .replace('custom:', '')
      .split(',')
      .map((d) => DAY_LETTER_TO_INDEX[d.trim()])
      .filter((d): d is number => d !== undefined)

    if (allowedDays.length === 0) {
      next.setUTCDate(next.getUTCDate() + 1) // invalid rule → daily
    } else {
      do {
        next.setUTCDate(next.getUTCDate() + 1)
      } while (!allowedDays.includes(next.getUTCDay()))
    }
  } else {
    // Unknown rule, default to daily.
    next.setUTCDate(next.getUTCDate() + 1)
  }

  return next
}

/** Generate the next occurrence for a recurring parent task. */
export async function generateNextOccurrence(
  userId: string,
  parentTask: TaskModel,
): Promise<TaskModel> {
  const refDate = parentTask.scheduledDate || new Date()
  const rule = (parentTask as any).recurrenceRule || 'daily'
  const nextDate = getNextOccurrenceDate(rule, refDate)
  const nextDateISO = nextDate.toISOString().split('T')[0]!

  return tasksRepository.create(userId, {
    title: parentTask.title,
    description: parentTask.description,
    priority: parentTask.priority,
    tags: parentTask.tags || [],
    weeklyGoalId: (parentTask as any).weeklyGoalId,
    isAllDay: parentTask.isAllDay,
    estimatedDurationMinutes: parentTask.estimatedDurationMinutes,
    scheduledDate: nextDateISO,
    recurringParentId: parentTask.id,
    source: 'recurring',
  })
}

/**
 * Process all recurring tasks for `userId`, generating instances for today
 * if they don't already exist.
 *
 * Day-of-week / day-of-month checks use the user's local timezone via
 * `localDayOfWeek` / parsed `localYmd`. The previous implementation read
 * `today.getUTCDay()` directly, which gave Wednesday on a Tokyo user's
 * Thursday morning (their local "today" began at Wed 15:00 UTC) and
 * silently skipped weekly/custom rules that should have fired.
 */
export async function processRecurringTasks(
  userId: string,
): Promise<{ generated: TaskModel[] }> {
  const recurringTasks = await tasksRepository.findRecurringTasks(userId)
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { timezone: true },
  })
  const tz = settings?.timezone ?? 'UTC'
  const now = new Date()
  const todayYmd = localYmd(now, tz)
  const todayDayOfWeek = localDayOfWeek(now, tz)
  const todayDayOfMonth = Number(todayYmd.slice(8, 10))

  const generated: TaskModel[] = []

  for (const parent of recurringTasks) {
    const rule = (parent as any).recurrenceRule
    if (!rule) continue

    // Skip if an instance already exists for today.
    const existing = await tasksRepository.findInstancesForDate(
      userId,
      parent.id,
      todayYmd,
    )
    if (existing.length > 0) continue

    let shouldGenerate = false

    if (rule === 'daily') {
      shouldGenerate = true
    } else if (rule === 'weekly') {
      // Generate if it's the same day-of-week as the parent's scheduledDate
      // (or as today if the parent never had one).
      const parentDay = parent.scheduledDate
        ? localDayOfWeek(new Date(parent.scheduledDate), tz)
        : todayDayOfWeek
      shouldGenerate = todayDayOfWeek === parentDay
    } else if (rule === 'monthly') {
      // Same day-of-month as the parent's scheduledDate.
      const parentDom = parent.scheduledDate
        ? Number(localYmd(new Date(parent.scheduledDate), tz).slice(8, 10))
        : todayDayOfMonth
      shouldGenerate = todayDayOfMonth === parentDom
    } else if (rule === 'weekdays') {
      shouldGenerate = todayDayOfWeek >= 1 && todayDayOfWeek <= 5
    } else if (rule.startsWith('custom:')) {
      const allowedDays = rule
        .replace('custom:', '')
        .split(',')
        .map((d: string) => DAY_LETTER_TO_INDEX[d.trim()])
        .filter((d: number | undefined): d is number => d !== undefined)
      shouldGenerate = allowedDays.includes(todayDayOfWeek)
    }

    if (!shouldGenerate) continue

    const instance = await tasksRepository.create(userId, {
      title: parent.title,
      description: parent.description,
      priority: parent.priority,
      tags: parent.tags || [],
      weeklyGoalId: (parent as any).weeklyGoalId,
      isAllDay: parent.isAllDay,
      estimatedDurationMinutes: parent.estimatedDurationMinutes,
      scheduledDate: todayYmd,
      recurringParentId: parent.id,
      source: 'recurring',
    })

    generated.push(instance)
  }

  return { generated }
}
