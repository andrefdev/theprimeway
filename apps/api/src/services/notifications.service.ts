import { notificationsRepo } from '../repositories/notifications.repo'
import { gamificationService } from './gamification.service'
import { getGoogleEvents } from './calendar/google-events-sync.service'
import { sendExpoPush, isPushEnabled as isExpoEnabled, isValidExpoPushToken } from '../lib/expo-push'
import { sendFcm, isFcmEnabled } from '../lib/firebase'
import { startOfLocalDayUtc } from '@repo/shared/utils'

function isPushEnabled() {
  return isExpoEnabled() || isFcmEnabled()
}

function partitionTokens(tokens: string[]): { expo: string[]; fcm: string[] } {
  const expo: string[] = []
  const fcm: string[] = []
  for (const t of tokens) {
    if (isValidExpoPushToken(t)) expo.push(t)
    else fcm.push(t)
  }
  return { expo, fcm }
}

async function sendToTokens(
  tokens: string[],
  payload: { title: string; body: string; url?: string; tag?: string; image?: string; data?: unknown },
): Promise<{ successCount: number; failureCount: number; invalidTokens: string[] }> {
  const { expo, fcm } = partitionTokens(tokens)
  const [expoRes, fcmRes] = await Promise.all([
    expo.length > 0 ? sendExpoPush(expo, payload) : Promise.resolve({ successCount: 0, failureCount: 0, invalidTokens: [] as string[] }),
    fcm.length > 0 ? sendFcm(fcm, payload) : Promise.resolve({ successCount: 0, failureCount: 0, invalidTokens: [] as string[] }),
  ])
  return {
    successCount: expoRes.successCount + fcmRes.successCount,
    failureCount: expoRes.failureCount + fcmRes.failureCount,
    invalidTokens: [...expoRes.invalidTokens, ...fcmRes.invalidTokens],
  }
}
import * as Sentry from '@sentry/node'

interface AppNotification {
  id: string
  type: 'overdue_task' | 'habit_missed'
  title: string
  message: string
  href: string
  created_at: string
}

interface SmartReminder {
  habitId: string
  habitName: string
  urgency: 'high' | 'medium' | 'low'
  message: string
  streakAtRisk: boolean
  calendarBusy: boolean
}

class NotificationsService {
  async registerDevice(
    userId: string,
    body: { token: string; deviceType: string; deviceName?: string },
  ) {
    const validDeviceTypes = ['web', 'android', 'ios']
    if (!body.token || !body.deviceType) {
      return { error: 'missing_fields' as const }
    }
    if (!validDeviceTypes.includes(body.deviceType)) {
      return { error: 'invalid_device_type' as const }
    }

    const device = await notificationsRepo.upsertDevice(
      body.token,
      {
        userId,
        deviceType: body.deviceType,
        deviceName: body.deviceName || null,
        isActive: true,
        lastUsedAt: new Date(),
      },
      {
        userId,
        fcmToken: body.token,
        deviceType: body.deviceType,
        deviceName: body.deviceName || null,
        isActive: true,
      },
    )

    return { data: device }
  }

  async unregisterDevice(userId: string, token: string) {
    if (!token) return { error: 'missing_token' as const }
    await notificationsRepo.deleteDevicesByToken(token, userId)
    return { success: true }
  }

  async getPreferences(userId: string) {
    return notificationsRepo.getOrCreatePreferences(userId)
  }

  async updatePreferences(userId: string, body: Record<string, unknown>) {
    const updateData: Record<string, unknown> = {}
    if (body.habit_reminders !== undefined) updateData.habitReminders = body.habit_reminders
    if (body.pomodoro_alerts !== undefined) updateData.pomodoroAlerts = body.pomodoro_alerts
    if (body.task_reminders !== undefined) updateData.taskReminders = body.task_reminders
    if (body.daily_motivation !== undefined) updateData.dailyMotivation = body.daily_motivation
    if (body.marketing_messages !== undefined) updateData.marketingMessages = body.marketing_messages
    if (body.task_reminder_offset !== undefined) updateData.taskReminderOffset = body.task_reminder_offset
    if (body.habit_reminder_time !== undefined) updateData.habitReminderTime = body.habit_reminder_time

    return notificationsRepo.upsertPreferences(userId, updateData)
  }

  async getAggregated(userId: string): Promise<AppNotification[]> {

    const notifications: AppNotification[] = []
    const now = new Date()
    const todayNoonUTC = new Date(`${now.toISOString().split('T')[0]}T12:00:00.000Z`)
    const todayStartUTC = new Date(`${now.toISOString().split('T')[0]}T00:00:00.000Z`)
    const tomorrowStartUTC = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000)

    // 1. Overdue tasks
    const overdueTasks = await notificationsRepo.findOverdueTasks(userId, todayNoonUTC)
    for (const task of overdueTasks) {
      const dueDateStr = task.dueDate ? new Date(task.dueDate).toLocaleDateString() : ''
      notifications.push({
        id: `overdue_task_${task.id}`,
        type: 'overdue_task',
        title: task.title,
        message: dueDateStr ? `Due ${dueDateStr}` : 'Past due',
        href: '/tasks',
        created_at: task.dueDate ? task.dueDate.toISOString() : new Date().toISOString(),
      })
    }

    // 2. Active habits not logged today
    const activeHabits = await notificationsRepo.findActiveHabitsWithTodayLogs(
      userId,
      todayStartUTC,
      tomorrowStartUTC,
    )
    for (const habit of activeHabits) {
      const hasLogToday =
        habit.logs.length > 0 && habit.logs.some((l) => (l.completedCount ?? 0) > 0)

      if (!hasLogToday) {
        notifications.push({
          id: `habit_missed_${habit.id}`,
          type: 'habit_missed',
          title: habit.name,
          message: 'Not logged today',
          href: '/habits',
          created_at: new Date().toISOString(),
        })
      }
    }

    return notifications
  }

  async generateSmartReminders(userId: string): Promise<SmartReminder[]> {
    const now = new Date()
    const todayStr = now.toISOString().split('T')[0]!
    const todayStartUTC = new Date(`${todayStr}T00:00:00.000Z`)
    const tomorrowStartUTC = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000)

    // Fetch active habits with today's logs
    const activeHabits = await notificationsRepo.findActiveHabitsWithTodayLogs(
      userId,
      todayStartUTC,
      tomorrowStartUTC,
    )

    // Fetch gamification profile for streak info
    let currentStreak = 0
    try {
      const profile = await gamificationService.getProfile(userId, todayStr)
      currentStreak = profile.currentStreak ?? 0
    } catch {
      // Gamification profile may not exist yet
    }

    // Fetch today's calendar density
    let calendarDensity = 0
    try {
      const dayStart = new Date(`${todayStr}T00:00:00.000Z`)
      const dayEnd = new Date(`${todayStr}T23:59:59.999Z`)
      const events = await getGoogleEvents(
        userId,
        dayStart.toISOString(),
        dayEnd.toISOString(),
      )
      calendarDensity = Array.isArray(events) ? events.length : 0
    } catch {
      // Calendar may not be connected
    }

    const calendarBusy = calendarDensity > 5
    const reminders: SmartReminder[] = []

    for (const habit of activeHabits) {
      const hasLogToday =
        habit.logs.length > 0 && habit.logs.some((l) => (l.completedCount ?? 0) > 0)

      if (hasLogToday) continue

      // Determine urgency
      const streakAtRisk = currentStreak > 7
      let urgency: SmartReminder['urgency']

      if (streakAtRisk) {
        urgency = 'high'
      } else {
        // All active habits not done are at least medium
        urgency = 'medium'
      }

      // Smart suppress: if calendar busy, only keep high urgency
      if (calendarBusy && urgency !== 'high') {
        continue
      }

      // Generate contextual message
      let message: string
      if (urgency === 'high') {
        message = `${currentStreak}-day streak at risk! Complete "${habit.name}" today.`
      } else if (calendarBusy) {
        message = `Busy day — focus on essentials. Don't forget: ${habit.name}`
      } else {
        message = `Don't forget: ${habit.name}`
      }

      reminders.push({
        habitId: habit.id,
        habitName: habit.name,
        urgency,
        message,
        streakAtRisk,
        calendarBusy,
      })
    }

    // Sort: high urgency first, then medium, then low
    const urgencyOrder = { high: 0, medium: 1, low: 2 }
    reminders.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency])

    return reminders
  }

  async syncPersistedInbox(userId: string) {
    // Persist derived notifications into the notifications table so the user
    // can mark read / dismiss them. Dedupes by (userId, type, entityId).
    const aggregated = await this.getAggregated(userId)
    const smartReminders = await this.generateSmartReminders(userId)

    const upserts: Array<{
      type: string
      title: string
      message: string
      href?: string | null
      urgency?: string | null
      data?: unknown
      entityId: string
    }> = []

    for (const n of aggregated) {
      upserts.push({
        type: n.type,
        entityId: n.id,
        title: n.title,
        message: n.message,
        href: n.href,
        urgency: null,
      })
    }

    for (const sr of smartReminders) {
      upserts.push({
        type: 'smart_reminder',
        entityId: `smart_reminder_${sr.habitId}`,
        title: sr.habitName,
        message: sr.message,
        href: '/habits',
        urgency: sr.urgency,
        data: { streakAtRisk: sr.streakAtRisk, calendarBusy: sr.calendarBusy },
      })
    }

    const keepEntityIds = upserts.map((u) => u.entityId)
    const userTz = await notificationsRepo.findUserTimezone(userId)
    const now = new Date()
    const localDayStart = startOfLocalDayUtc(now, userTz)
    const pushTargets: Array<{
      notificationId: string
      title: string
      message: string
      href: string | null
      urgency: string | null
      type: string
    }> = []

    for (const u of upserts) {
      const result = await notificationsRepo.upsertNotification({ userId, ...u })
      // Throttle to one push per (userId, entityId) per local day. The cron
      // path uses lastHabitReminderAt for the same reason; this guards the
      // inbox-sync path against a polling client (web bell every 60s) that
      // would otherwise re-push every cycle for a still-pending habit.
      const alreadyPushedToday =
        result.lastPushSentAt !== null && result.lastPushSentAt >= localDayStart
      if (alreadyPushedToday) continue

      pushTargets.push({
        notificationId: result.notification.id,
        title: u.title,
        message: u.message,
        href: u.href ?? null,
        urgency: u.urgency ?? null,
        type: u.type,
      })
    }

    // Auto-dismiss stale derived notifications (source entity no longer applies).
    await notificationsRepo.pruneStale(userId, {
      keepTypes: ['overdue_task', 'habit_missed', 'smart_reminder'],
      keepEntityIds,
    })

    // Fire-and-forget push for fresh notifications.
    if (pushTargets.length > 0 && isPushEnabled()) {
      // Mark pushed synchronously *before* the async send so a re-entrant sync
      // (e.g. two inbox polls landing in the same second) cannot both pass the
      // throttle and double-push.
      await Promise.all(
        pushTargets.map((p) =>
          notificationsRepo.markNotificationPushed(p.notificationId, now),
        ),
      )
      void Promise.all(
        pushTargets.map((p) =>
          this.sendPushToUser(userId, {
            title: p.title,
            body: p.message,
            url: p.href ?? undefined,
            tag: p.type,
          }).catch((err) => {
            console.error('[push] send failed', err)
            Sentry.captureException(err, { tags: { area: 'push_send' } })
          }),
        ),
      )
    }
  }

  async sendPushToUser(
    userId: string,
    payload: { title: string; body: string; url?: string; tag?: string; image?: string },
  ) {
    if (!isPushEnabled()) return { success_count: 0, failure_count: 0, skipped: true }

    const devices = await notificationsRepo.findActiveDeviceTokensForUser(userId)
    const tokens = devices.map((d: { fcmToken: string }) => d.fcmToken).filter(Boolean)
    if (tokens.length === 0) return { success_count: 0, failure_count: 0 }

    const res = await sendToTokens(tokens, payload)

    await Promise.all(
      res.invalidTokens.map((token) => notificationsRepo.markDeviceInactive(token)),
    )

    return { success_count: res.successCount, failure_count: res.failureCount }
  }

  // Per-user TTL so /inbox doesn't trigger a full derived-notification sync
  // on every poll. The sync is heavy (calendar API + many upserts).
  private lastSyncAt = new Map<string, number>()
  private readonly syncTtlMs = 60_000

  async listInbox(
    userId: string,
    opts: { includeRead?: boolean; includeDismissed?: boolean; limit?: number; offset?: number },
  ) {
    const last = this.lastSyncAt.get(userId) ?? 0
    if (Date.now() - last > this.syncTtlMs) {
      this.lastSyncAt.set(userId, Date.now())
      // Fire-and-forget so the response isn't blocked on calendar/upserts.
      void this.syncPersistedInbox(userId).catch((err) => {
        console.error('[notifications] syncPersistedInbox failed', err)
        Sentry.captureException(err, { tags: { area: 'notifications_sync' } })
        this.lastSyncAt.delete(userId)
      })
    }
    return notificationsRepo.listNotifications(userId, {
      includeRead: opts.includeRead ?? true,
      includeDismissed: opts.includeDismissed ?? false,
      limit: Math.min(opts.limit ?? 50, 200),
      offset: opts.offset ?? 0,
    })
  }

  async markRead(userId: string, id: string) {
    return notificationsRepo.markRead(userId, id)
  }

  async markAllRead(userId: string) {
    return notificationsRepo.markAllRead(userId)
  }

  async dismiss(userId: string, id: string) {
    return notificationsRepo.dismiss(userId, id)
  }

  async dismissAll(userId: string) {
    return notificationsRepo.dismissAll(userId)
  }

  async deleteNotification(userId: string, id: string) {
    return notificationsRepo.deleteNotification(userId, id)
  }

  async getBatchedNotifications(userId: string) {
    // Ensure inbox reflects current state before batching.
    await this.syncPersistedInbox(userId)
    const rawNotifications = await this.getAggregated(userId)
    const rawSmartReminders = await this.generateSmartReminders(userId)

    // Filter out dismissed items by looking up persisted Notification rows.
    const { data: persisted } = await notificationsRepo.listNotifications(userId, {
      includeRead: true,
      includeDismissed: true,
      limit: 500,
      offset: 0,
    })
    const dismissed = new Set(
      persisted.filter((p: any) => p.dismissedAt).map((p: any) => p.entityId),
    )
    const notifications = rawNotifications.filter((n) => !dismissed.has(n.id))
    const smartReminders = rawSmartReminders.filter(
      (sr) => !dismissed.has(`smart_reminder_${sr.habitId}`),
    )

    // Group notifications by type
    const overdueTasks = notifications.filter((n) => n.type === 'overdue_task')
    const missedHabits = notifications.filter((n) => n.type === 'habit_missed')

    const batched: Array<{
      type: 'batch_tasks' | 'batch_habits' | 'smart_reminder'
      title: string
      message: string
      count: number
      items: Array<{ id: string; title: string; href: string }>
      urgency?: 'high' | 'medium' | 'low'
    }> = []

    if (overdueTasks.length > 0) {
      batched.push({
        type: 'batch_tasks',
        title:
          overdueTasks.length === 1
            ? overdueTasks[0]!.title
            : `${overdueTasks.length} overdue tasks`,
        message:
          overdueTasks.length === 1
            ? overdueTasks[0]!.message
            : overdueTasks
                .slice(0, 3)
                .map((t) => t.title)
                .join(', ') + (overdueTasks.length > 3 ? '...' : ''),
        count: overdueTasks.length,
        items: overdueTasks.map((t) => ({ id: t.id, title: t.title, href: t.href })),
        urgency: overdueTasks.length >= 5 ? 'high' : overdueTasks.length >= 3 ? 'medium' : 'low',
      })
    }

    if (missedHabits.length > 0) {
      batched.push({
        type: 'batch_habits',
        title:
          missedHabits.length === 1
            ? missedHabits[0]!.title
            : `${missedHabits.length} habits to complete`,
        message:
          missedHabits.length === 1
            ? missedHabits[0]!.message
            : missedHabits
                .slice(0, 3)
                .map((h) => h.title)
                .join(', ') + (missedHabits.length > 3 ? '...' : ''),
        count: missedHabits.length,
        items: missedHabits.map((h) => ({ id: h.id, title: h.title, href: h.href })),
      })
    }

    // Add smart reminders as individual items (already prioritized)
    for (const sr of smartReminders) {
      batched.push({
        type: 'smart_reminder',
        title: sr.habitName,
        message: sr.message,
        count: 1,
        items: [{ id: sr.habitId, title: sr.habitName, href: '/habits' }],
        urgency: sr.urgency,
      })
    }

    return {
      batched,
      totalCount: notifications.length + smartReminders.length,
    }
  }

  private async resolveAdminTargetUserIds(userIds?: string[]): Promise<string[]> {
    if (userIds && userIds.length > 0) return userIds
    return notificationsRepo.findAllUserIds()
  }

  async sendPush(body: {
    userIds?: string[]
    title: string
    body: string
    url?: string
    data?: unknown
    image?: string
    tag?: string
  }) {
    if (!body.title || !body.body) {
      return { error: 'missing_fields' as const }
    }

    const whereClause: Record<string, unknown> = { isActive: true }
    if (body.userIds && Array.isArray(body.userIds) && body.userIds.length > 0) {
      whereClause.userId = { in: body.userIds }
    }

    const devices = await notificationsRepo.findActiveDevices(whereClause)

    // Persist admin-sent message to each target user's inbox so it appears in
    // the bell even if push is disabled or no device is registered.
    const targetUserIds = await this.resolveAdminTargetUserIds(body.userIds)
    const inboxEntityId = `admin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await Promise.all(
      targetUserIds.map((userId) =>
        notificationsRepo
          .upsertNotification({
            userId,
            type: 'admin_message',
            entityId: inboxEntityId,
            title: body.title,
            message: body.body,
            href: body.url ?? null,
            urgency: null,
            data: body.data,
          })
          .catch((err) => {
            console.error('[notifications] admin inbox persist failed', err)
            Sentry.captureException(err, { tags: { area: 'admin_inbox_persist' } })
          }),
      ),
    )

    if (devices.length === 0) {
      return {
        message: 'No devices found',
        success_count: 0,
        failure_count: 0,
        inbox_persisted: targetUserIds.length,
      }
    }

    if (!isPushEnabled()) {
      return {
        message: 'Push disabled (no expo or firebase credentials configured)',
        total_devices: devices.length,
        success_count: 0,
        failure_count: 0,
      }
    }

    const tokens = devices.map((d: { fcmToken: string }) => d.fcmToken).filter(Boolean)

    const res = await sendToTokens(tokens, {
      title: body.title,
      body: body.body,
      url: body.url,
      tag: body.tag,
      image: body.image,
      data: body.data,
    })

    await Promise.all(
      res.invalidTokens.map((token) => notificationsRepo.markDeviceInactive(token)),
    )

    return {
      total_devices: devices.length,
      success_count: res.successCount,
      failure_count: res.failureCount,
    }
  }
}

export const notificationsService = new NotificationsService()
