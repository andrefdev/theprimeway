import { cronRepo } from '../repositories/cron.repo'
import { chatService } from './chat.service'
import { gamificationService } from './gamification.service'
import { notificationsService } from './notifications.service'
import { prisma } from '../lib/prisma'
import {
  endOfLocalDayUtc,
  formatInTz,
  localDayOfWeek,
  startOfLocalDayUtc,
} from '@repo/shared/utils'

// ---------------------------------------------------------------------------
// Motivational messages
// ---------------------------------------------------------------------------
const MOTIVATION_MESSAGES = {
  en: [
    "Believe you can and you're halfway there.",
    'The only way to do great work is to love what you do.',
    "Your time is limited, don't waste it living someone else's life.",
    'Success is not final, failure is not fatal: it is the courage to continue that counts.',
    'Hardships often prepare ordinary people for an extraordinary destiny.',
    'Dream big and dare to fail.',
    'It does not matter how slowly you go as long as you do not stop.',
    "Everything you've ever wanted is on the other side of fear.",
    'Success is getting what you want, happiness is wanting what you get.',
    "Don't count the days, make the days count.",
  ],
  es: [
    'Cree que puedes y ya estaras a medio camino.',
    'La unica forma de hacer un gran trabajo es amar lo que haces.',
    'Tu tiempo es limitado, no lo desperdicies viviendo la vida de alguien mas.',
    'El exito no es definitivo, el fracaso no es fatal: lo que cuenta es el valor para continuar.',
    'Las dificultades a menudo preparan a la gente comun para un destino extraordinario.',
    'Suena en grande y atrevete a fallar.',
    'No importa lo lento que vayas siempre y cuando no te detengas.',
    'Todo lo que siempre has querido esta al otro lado del miedo.',
    'El exito es conseguir lo que quieres, la felicidad es querer lo que consigues.',
    'No cuentes los dias, haz que los dias cuenten.',
  ],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatTimeUntil(minutes: number, lang: string): string {
  if (minutes <= 1) return lang === 'es' ? 'en 1 minuto' : 'in 1 minute'
  if (minutes < 60) return lang === 'es' ? `en ${minutes} minutos` : `in ${minutes} minutes`
  const hours = Math.round(minutes / 60)
  if (hours === 1) return lang === 'es' ? 'en 1 hora' : 'in 1 hour'
  if (hours < 24) return lang === 'es' ? `en ${hours} horas` : `in ${hours} hours`
  return lang === 'es' ? 'en 1 dia' : 'in 1 day'
}

function isWithinReminderWindow(now: Date, reminderTime: string, timezone: string): boolean {
  const [targetHour = 0, targetMinute = 0] = reminderTime.split(':').map(Number)
  const hhmm = formatInTz(now, timezone, 'HH:mm')
  const [userHour = 0, userMinute = 0] = hhmm.split(':').map(Number)
  const targetTotalMinutes = targetHour * 60 + targetMinute
  const currentTotalMinutes = userHour * 60 + userMinute
  const diff = currentTotalMinutes - targetTotalMinutes
  return diff >= 0 && diff < 5
}

class CronService {
  async sendDailyMotivation() {
    const users = await cronRepo.findUsersWithDailyMotivation()

    if (users.length === 0) {
      return { message: 'No users to send to' }
    }

    const usersByLang: Record<string, string[]> = { en: [], es: [] }
    for (const user of users) {
      const locale = user.settings?.locale || 'en'
      const lang = locale.startsWith('es') ? 'es' : 'en'
      usersByLang[lang]!.push(user.id)
    }

    const titleByLang = { en: 'Your daily dose of motivation', es: 'Tu dosis diaria de motivación' }
    const results: Array<{ lang: string; userCount: number; message: string; sent: number; failed: number }> = []

    for (const [lang, userIds] of Object.entries(usersByLang)) {
      if (userIds.length === 0) continue

      const messages = MOTIVATION_MESSAGES[lang as keyof typeof MOTIVATION_MESSAGES]
      const randomMessage = messages[Math.floor(Math.random() * messages.length)]!
      const title = titleByLang[lang as 'en' | 'es']

      let sent = 0
      let failed = 0
      for (const userId of userIds) {
        const res = await notificationsService.sendPushToUser(userId, {
          title,
          body: randomMessage,
          url: '/dashboard',
          tag: 'daily-motivation',
        })
        sent += res.success_count
        failed += res.failure_count
      }

      results.push({ lang, userCount: userIds.length, message: randomMessage, sent, failed })
    }

    return { success: true, results }
  }

  async processReminders(now: Date) {
    const [taskResults, habitResults] = await Promise.all([
      this.processTaskReminders(now),
      this.processHabitReminders(now),
    ])

    return { success: true, timestamp: now.toISOString(), tasks: taskResults, habits: habitResults }
  }

  async processHabitRemindersOnly(now: Date) {
    return this.processHabitReminders(now)
  }

  private async processTaskReminders(now: Date) {
    const users = await cronRepo.findUsersWithTaskReminders()

    if (users.length === 0) {
      return { message: 'No users with task reminders enabled', sent: 0 }
    }

    const nowMs = now.getTime()
    let totalSent = 0
    const errors: string[] = []

    for (const user of users) {
      const offsetMinutes = user.notificationPreferences?.taskReminderOffset ?? 30
      const reminderWindowMs = offsetMinutes * 60 * 1000

      const tasks = await cronRepo.findTasksForReminder(
        user.id,
        new Date(nowMs),
        new Date(nowMs + reminderWindowMs),
      )

      if (tasks.length === 0) continue

      const devices = await cronRepo.findActiveDevicesByUserId(user.id)
      if (devices.length === 0) continue

      const locale = user.settings?.locale || 'en'
      const lang = locale.startsWith('es') ? 'es' : 'en'

      for (const task of tasks) {
        const targetDate = task.scheduledStart || task.dueDate!
        const minutesUntil = Math.round((targetDate.getTime() - nowMs) / 60000)
        const whenLabel = formatTimeUntil(minutesUntil, lang)
        const title = lang === 'es' ? 'Recordatorio de tarea' : 'Task reminder'
        const body = lang === 'es' ? `${task.title} · ${whenLabel}` : `${task.title} · ${whenLabel}`

        try {
          await notificationsService.sendPushToUser(user.id, {
            title,
            body,
            url: '/tasks/today',
            tag: `task-reminder-${task.id}`,
          })
          await cronRepo.markTaskReminded(task.id)
          totalSent++
        } catch (error) {
          errors.push(`Task ${task.id}: ${String(error)}`)
        }
      }
    }

    return { sent: totalSent, errors: errors.length > 0 ? errors : undefined }
  }

  private async processHabitReminders(now: Date) {
    const users = await cronRepo.findUsersWithHabitReminders()

    if (users.length === 0) {
      return { message: 'No users with habit reminders', sent: 0 }
    }

    const usersToRemind: Record<string, string[]> = { en: [], es: [] }

    for (const user of users) {
      const reminderTime = user.notificationPreferences?.habitReminderTime ?? '20:00'
      const userTz = user.settings?.timezone || 'UTC'

      if (!isWithinReminderWindow(now, reminderTime, userTz)) continue

      const todayStart = startOfLocalDayUtc(now, userTz)
      const todayEnd = endOfLocalDayUtc(now, userTz)
      const currentDayIndex = localDayOfWeek(now, userTz)

      // Skip if a habit reminder already went out in the user's local day.
      const lastSent = user.notificationPreferences?.lastHabitReminderAt
      if (lastSent && lastSent >= todayStart && lastSent <= todayEnd) continue

      const habitLogs = await cronRepo.findHabitLogsByUserAndDate(user.id, todayStart, todayEnd)

      let hasIncomplete = false
      for (const habit of user.habits) {
        if (habit.weekDays && Array.isArray(habit.weekDays)) {
          const days = habit.weekDays as number[]
          if (!days.includes(currentDayIndex)) continue
        }

        const log = habitLogs.find((l) => l.taskId === habit.id)
        const completed = log?.completedCount || 0
        const target = habit.targetFrequency || 1

        if (completed < target) {
          hasIncomplete = true
          break
        }
      }

      if (hasIncomplete) {
        const locale = user.settings?.locale || 'en'
        const lang = locale.startsWith('es') ? 'es' : 'en'
        usersToRemind[lang]!.push(user.id)
      }
    }

    const copyByLang = {
      en: { title: "Don't break the chain", body: 'You still have habits to complete today.' },
      es: { title: 'No rompas la cadena', body: 'Aún tienes hábitos por completar hoy.' },
    }

    let totalSent = 0
    let totalFailed = 0
    for (const [lang, userIds] of Object.entries(usersToRemind)) {
      if (userIds.length === 0) continue

      const { title, body } = copyByLang[lang as 'en' | 'es']
      for (const userId of userIds) {
        const res = await notificationsService.sendPushToUser(userId, {
          title,
          body,
          url: '/habits',
          tag: 'habit-reminder',
        })
        totalSent += res.success_count
        totalFailed += res.failure_count

        // Mark as sent to prevent re-sending within the same local day.
        await prisma.notificationPreferences.update({
          where: { userId },
          data: { lastHabitReminderAt: new Date() },
        })
      }
    }

    return { sent: totalSent, failed: totalFailed }
  }

  async processQuarterlyReview() {
    // Only run on quarter boundaries (last 3 days of Mar, Jun, Sep, Dec)
    const now = new Date()
    const month = now.getMonth() // 0-indexed
    const day = now.getDate()
    const lastDayOfMonth = new Date(now.getFullYear(), month + 1, 0).getDate()

    const isQuarterEnd = [2, 5, 8, 11].includes(month) && day >= lastDayOfMonth - 2
    if (!isQuarterEnd) {
      return { skipped: true, message: 'Not a quarter-end period' }
    }

    const quarter = (Math.floor(month / 3) + 1) as 1 | 2 | 3 | 4
    const year = now.getFullYear()

    // Get all users with active QUARTER goals
    const users = await prisma.user.findMany({
      where: {
        goals: { some: { horizon: 'QUARTER', status: 'ACTIVE' } },
      },
      select: { id: true, email: true, name: true, settings: { select: { locale: true } } },
    })

    const results: Array<{ userId: string; status: string; error?: string }> = []

    for (const user of users) {
      try {
        // Quarterly review generation deferred to Phase 3 (Rituals).
        void quarter
        void year

        // Check quarterly milestone achievements
        await gamificationService.checkAchievements(user.id)

        results.push({ userId: user.id, status: 'generated' })

        const lang = (user.settings?.locale || 'en').startsWith('es') ? 'es' : 'en'
        const title =
          lang === 'es' ? `Tu revisión del Q${quarter} está lista` : `Your Q${quarter} review is ready`
        const body =
          lang === 'es'
            ? 'Revisa tu progreso trimestral y planifica el próximo ciclo.'
            : 'Review your quarterly progress and plan the next cycle.'

        await notificationsService.sendPushToUser(user.id, {
          title,
          body,
          url: '/goals',
          tag: `quarterly-review-q${quarter}-${year}`,
        })
      } catch (err) {
        results.push({ userId: user.id, status: 'failed', error: (err as Error).message })
      }
    }

    return { quarter, year, processed: results.length, results }
  }

  async processWeeklyReview() {
    // Only run on Sundays (day 0) or Mondays (day 1)
    const now = new Date()
    const dayOfWeek = now.getDay()
    if (dayOfWeek !== 0 && dayOfWeek !== 1) {
      return { skipped: true, message: 'Weekly review only runs on Sunday/Monday' }
    }

    // Calculate next week's Monday
    const nextMonday = new Date(now)
    const daysUntilMonday = dayOfWeek === 0 ? 1 : 7
    nextMonday.setDate(nextMonday.getDate() + daysUntilMonday)
    const weekStartDate = nextMonday.toISOString().split('T')[0]!

    // Get all active users (users with recent activity)
    const recentCutoff = new Date()
    recentCutoff.setDate(recentCutoff.getDate() - 14)

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { tasks: { some: { updatedAt: { gte: recentCutoff } } } },
          { tasks: { some: { kind: 'HABIT', archivedAt: null } } },
        ],
      },
      select: { id: true, name: true, settings: { select: { locale: true } } },
    })

    // Calculate the week start (Monday) for snapshots
    const snapshotWeekStart = new Date(weekStartDate)

    const results: Array<{ userId: string; status: string; error?: string }> = []
    for (const user of users) {
      try {
        // Generate the weekly plan
        const plan = await chatService.weeklyPlanning(user.id, weekStartDate)

        // GoalHealthSnapshot dropped in Phase 1; reintroduce in Phase 3 rituals/reflections.
        void snapshotWeekStart

        void plan

        const lang = (user.settings?.locale || 'en').startsWith('es') ? 'es' : 'en'
        const title = lang === 'es' ? 'Tu plan semanal está listo' : 'Your weekly plan is ready'
        const body =
          lang === 'es'
            ? 'Revisa tus prioridades de la semana y empieza con impulso.'
            : 'Check your priorities for the week and start with momentum.'

        await notificationsService.sendPushToUser(user.id, {
          title,
          body,
          url: '/dashboard',
          tag: `weekly-review-${weekStartDate}`,
        })

        results.push({ userId: user.id, status: 'generated' })
      } catch (err) {
        results.push({ userId: user.id, status: 'failed', error: (err as Error).message })
      }
    }

    return { weekStartDate, processed: results.length, results }
  }

  async processQuarterlyNudge() {
    const now = new Date()
    const month = now.getMonth() // 0-indexed: 0=Jan, 3=Apr, 6=Jul, 9=Oct
    const day = now.getDate()

    // Guard: only run on day 1 of quarter-start months (Jan, Apr, Jul, Oct)
    const isQuarterStart = [0, 3, 6, 9].includes(month) && day === 1
    if (!isQuarterStart) {
      return { skipped: true, message: 'Not a quarter-start date' }
    }

    const quarter = (Math.floor(month / 3) + 1) as 1 | 2 | 3 | 4
    const year = now.getFullYear()

    // Fetch all users
    const users = await prisma.user.findMany({
      select: { id: true, settings: { select: { locale: true } } },
    })

    let nudged = 0
    let skipped = 0
    let alreadySet = 0

    for (const user of users) {
      const lang = (user.settings?.locale || 'en').startsWith('es') ? 'es' : 'en'

      // Check for quarterly goals in the current quarter
      const quarterlyGoals = await prisma.goal.findMany({
        where: { userId: user.id, horizon: 'QUARTER', periodKey: `${year}-Q${quarter}` },
        select: { id: true, objectives: true },
      })

      if (quarterlyGoals.length === 0) {
        // No goals at all -> strong nudge
        const title =
          lang === 'es' ? '¡Nuevo trimestre! Define tus metas' : 'New quarter! Set your goals'
        const body =
          lang === 'es'
            ? `Es Q${quarter} ${year}. Establece tus metas trimestrales para mantener el rumbo.`
            : `It's Q${quarter} ${year}. Set your quarterly goals to stay on track.`

        await notificationsService.sendPush({
          userIds: [user.id],
          title,
          body,
          url: '/goals',
          tag: 'quarterly-nudge',
        })
        nudged++
      } else {
        // Goals exist — check if <50% have measurable targets (non-empty objectives)
        const withTargets = quarterlyGoals.filter((g: { objectives: unknown }) => {
          if (!g.objectives) return false
          const objs = g.objectives as unknown[]
          return Array.isArray(objs) && objs.length > 0
        }).length

        const ratio = withTargets / quarterlyGoals.length

        if (ratio < 0.5) {
          // Softer nudge
          const title =
            lang === 'es' ? 'Revisa tus metas trimestrales' : 'Review your quarterly goals'
          const body =
            lang === 'es'
              ? 'Algunas de tus metas aún no tienen objetivos medibles. Revísalas.'
              : 'Some of your goals are missing measurable targets. Review them.'

          await notificationsService.sendPush({
            userIds: [user.id],
            title,
            body,
            url: '/goals',
            tag: 'quarterly-nudge',
          })
          nudged++
        } else {
          alreadySet++
        }
      }
    }

    skipped = users.length - nudged - alreadySet

    return { quarter, year, nudged, skipped, alreadySet }
  }

  // ---------------------------------------------------------------------------
  // Brain concept-graph re-clustering (Phase 2)
  //
  // For every user that has at least one concept, ask shouldRecluster() — true
  // if 7+ days since last run OR 20+ new concepts since then — and run the
  // clustering pipeline. We process users sequentially; clustering is O(n²) on
  // the per-user concept set so a global parallel fanout would risk DB
  // contention without much wallclock win at our current scale. Per-user errors
  // are logged but never abort the batch.
  // ---------------------------------------------------------------------------
  async processBrainClusterRefresh() {
    const { brainGraphService } = await import('./brain-graph.service')

    const users = await prisma.brainConcept.findMany({
      where: { mergedIntoId: null, deletedAt: null },
      distinct: ['userId'],
      select: { userId: true },
    })

    let processed = 0
    let skipped = 0
    let failed = 0
    let totalClusters = 0

    for (const { userId } of users) {
      try {
        const overdue = await brainGraphService.shouldRecluster(userId)
        if (!overdue) {
          skipped++
          continue
        }
        const result = await brainGraphService.runClustering(userId)
        if (result.skipped) {
          skipped++
          continue
        }
        processed++
        totalClusters += result.clustersCreated
      } catch (err) {
        failed++
        console.error('[CRON_BRAIN_CLUSTER]', userId, err)
      }
    }

    return {
      candidates: users.length,
      processed,
      skipped,
      failed,
      clustersCreated: totalClusters,
    }
  }
}

export const cronService = new CronService()
