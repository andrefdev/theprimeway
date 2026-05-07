import { calendarRepo } from '../repositories/calendar.repo'
import { tasksRepository } from '../repositories/tasks.repo'
import { prisma } from '../lib/prisma'
import { generateObject } from 'ai'
import { taskModel } from '../lib/ai-models'
import { z } from 'zod'
import {
  localTimeToUtc,
  localYmd,
  ymdToLocalDayUtc,
} from '@repo/shared/utils'
import { collectBusyBlocks, computeGaps, getDayWindow } from './scheduling/gap-finder'
import { syncService } from './sync.service'

class CalendarService {
  async listAccounts(userId: string) {
    const accounts = await calendarRepo.findAccountsByUser(userId)

    // Lazy backfill: if any Google calendar is missing accessRole, fetch it once
    // from Google's calendarList. Old rows pre-date the column.
    const needsBackfill = accounts.some(
      (acc: any) =>
        acc.provider === 'google' &&
        (acc.calendars ?? []).some((c: any) => c.accessRole == null),
    )
    if (needsBackfill) {
      await this.backfillAccessRoles(accounts).catch((err) =>
        console.error('[CAL_BACKFILL] failed', err),
      )
      return calendarRepo.findAccountsByUser(userId)
    }

    return accounts
  }

  private async backfillAccessRoles(accounts: any[]) {
    for (const account of accounts) {
      if (account.provider !== 'google') continue
      const missing = (account.calendars ?? []).filter((c: any) => c.accessRole == null)
      if (!missing.length) continue

      let accessToken: string | undefined = account.accessToken
      if (account.expiresAt && new Date() >= new Date(account.expiresAt) && account.refreshToken) {
        const refreshed = await this.refreshGoogleToken(account.refreshToken)
        if (refreshed) {
          accessToken = refreshed.access_token
          await calendarRepo.updateAccount(account.id, {
            accessToken: refreshed.access_token,
            tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
          })
        }
      }
      if (!accessToken) continue

      const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) continue
      const data = (await res.json()) as { items?: Array<{ id: string; accessRole?: string }> }
      const byId = new Map((data.items ?? []).map((i) => [i.id, i.accessRole]))

      for (const cal of missing) {
        const role = byId.get(cal.providerCalendarId)
        if (role) {
          await calendarRepo.updateCalendar(cal.id, { accessRole: role }).catch(() => {})
        }
      }
    }
  }

  async deleteAccount(userId: string, id: string) {
    const account = await calendarRepo.findAccountById(id)
    if (!account || account.userId !== userId) return null
    await calendarRepo.deleteAccount(id)
    return true
  }

  async updateAccountSettings(
    userId: string,
    id: string,
    body: { defaultTargetCalendarId?: string | null },
  ) {
    const account = await calendarRepo.findAccountById(id)
    if (!account || account.userId !== userId) return null
    const updateData: Record<string, unknown> = {}
    if (body.defaultTargetCalendarId !== undefined) {
      updateData.defaultTargetCalendarId = body.defaultTargetCalendarId
    }
    if (!Object.keys(updateData).length) return account
    return calendarRepo.updateAccount(id, updateData)
  }

  async updateCalendar(
    userId: string,
    id: string,
    body: { isSelectedForSync?: boolean; isPrimary?: boolean; color?: string },
  ) {
    const calendar = await calendarRepo.findCalendarById(id)
    if (!calendar) return { error: 'not_found' as const }

    const account = await calendarRepo.findAccountByCalendarAccountId(calendar.calendarAccountId)
    if (!account || account.userId !== userId) return { error: 'unauthorized' as const }

    const updateData: Record<string, unknown> = {}
    if (body.isSelectedForSync !== undefined) updateData.isSelectedForSync = body.isSelectedForSync
    if (body.isPrimary !== undefined) updateData.isPrimary = body.isPrimary
    if (body.color !== undefined) updateData.color = body.color

    // If setting isPrimary=true, unset all other primary calendars
    if (body.isPrimary === true) {
      const accounts = await calendarRepo.findAllUserAccountsWithCalendars(userId)
      for (const acc of accounts) {
        for (const cal of acc.calendars) {
          if (cal.isPrimary && cal.id !== id) {
            await calendarRepo.updateCalendar(cal.id, { isPrimary: false })
          }
        }
      }
    }

    return { data: await calendarRepo.updateCalendar(id, updateData) }
  }

  getGoogleOAuthUrl() {
    const clientId = process.env.AUTH_GOOGLE_ID
    const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI

    if (!clientId || !redirectUri) return null

    const scopes = [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ].join(' ')

    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent&state=calendar_oauth`
  }

  async handleGoogleCallback(userId: string, code: string) {
    const clientId = process.env.AUTH_GOOGLE_ID
    const clientSecret = process.env.AUTH_GOOGLE_SECRET
    const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI

    if (!clientId || !clientSecret || !redirectUri) {
      return { error: 'not_configured' as const, detail: 'AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET or GOOGLE_CALENDAR_REDIRECT_URI missing' }
    }

    try {
      // Exchange code for tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      })

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text()
        console.error('[GOOGLE_CALLBACK] Token exchange failed:', errText)
        return { error: 'token_exchange_failed' as const, detail: errText }
      }

      const tokens = (await tokenResponse.json()) as {
        access_token: string
        refresh_token?: string
        expires_in: number
      }
      console.log('[GOOGLE_CALLBACK] token exchange OK')

      // Get user info from Google. If userinfo scope wasn't granted, fall back
      // to the calendar primary id (which is the user's email for Google).
      let userInfo: { email?: string; name?: string } = {}
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      if (userInfoRes.ok) {
        userInfo = (await userInfoRes.json()) as { email?: string; name?: string }
        console.log('[GOOGLE_CALLBACK] userinfo OK', userInfo.email)
      } else {
        const errText = await userInfoRes.text()
        console.warn('[GOOGLE_CALLBACK] userinfo failed, will fall back to primary calendar id:', errText)
      }

      if (!userInfo.email) {
        const primaryRes = await fetch(
          'https://www.googleapis.com/calendar/v3/calendars/primary',
          { headers: { Authorization: `Bearer ${tokens.access_token}` } },
        )
        if (primaryRes.ok) {
          const primary = (await primaryRes.json()) as { id?: string; summary?: string }
          if (primary.id) {
            userInfo = { email: primary.id, name: primary.summary }
            console.log('[GOOGLE_CALLBACK] derived email from primary calendar', primary.id)
          }
        } else {
          const errText = await primaryRes.text()
          console.error('[GOOGLE_CALLBACK] primary calendar fallback failed:', errText)
        }
      }

      if (!userInfo.email) {
        return {
          error: 'userinfo_no_email' as const,
          detail: 'Could not determine Google account email from userinfo or primary calendar',
        }
      }

      // Upsert CalendarAccount
      const existingAccount = await calendarRepo.findAccountByProviderEmail(userId, 'google', userInfo.email)

      let account
      if (existingAccount) {
        account = await calendarRepo.updateAccount(existingAccount.id, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || existingAccount.refreshToken,
          tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        })
      } else {
        account = await calendarRepo.createAccount({
          userId,
          provider: 'google',
          providerAccountId: userInfo.email,
          providerEmail: userInfo.email,
          displayName: userInfo.name || userInfo.email,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || null,
          tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        })
      }
      console.log('[GOOGLE_CALLBACK] account upsert OK', account.id)

      // Fetch and store calendars from Google
      const calendarListRes = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      )
      if (!calendarListRes.ok) {
        const errText = await calendarListRes.text()
        console.error('[GOOGLE_CALLBACK] calendarList failed:', errText)
        return { error: 'calendar_list_failed' as const, detail: errText }
      }
      const calendarList = (await calendarListRes.json()) as {
        items?: Array<{
          id: string
          summary: string
          primary?: boolean
          backgroundColor?: string
          accessRole?: string
        }>
      }

      const upsertedCalendars: Array<{ id: string; isSelectedForSync: boolean | null | undefined }> = []
      if (calendarList.items) {
        for (const cal of calendarList.items) {
          const upserted = await calendarRepo.upsertCalendar(
            account.id,
            cal.id,
            { name: cal.summary, color: cal.backgroundColor, accessRole: cal.accessRole ?? null },
            {
              calendarAccountId: account.id,
              externalId: cal.id,
              name: cal.summary,
              color: cal.backgroundColor || null,
              isPrimary: cal.primary || false,
              isSelectedForSync: cal.primary || false,
              accessRole: cal.accessRole ?? null,
            },
          )
          upsertedCalendars.push({ id: upserted.id, isSelectedForSync: upserted.isSelectedForSync })
        }
      }
      console.log('[GOOGLE_CALLBACK] calendars upserted', upsertedCalendars.length)

      // Subscribe push-notification watch channels for synced calendars (fire-and-forget)
      for (const cal of upsertedCalendars) {
        if (cal.isSelectedForSync) {
          this.subscribeWatchChannel(cal.id).catch((err) =>
            console.error('[CAL_WATCH] subscribe on connect failed', err),
          )
        }
      }

      // Initial pull: populate CalendarEvent cache so gap-finder sees external
      // events on the very next scheduling request (fire-and-forget; webhooks
      // will keep it fresh going forward).
      this.syncCalendars(userId).catch((err) =>
        console.error('[CAL_SYNC] initial pull on connect failed', err),
      )

      return { data: account }
    } catch (err) {
      console.error('[GOOGLE_CALLBACK] unexpected error', err)
      return { error: 'callback_failed' as const, detail: (err as Error)?.message ?? String(err) }
    }
  }

  async getGoogleEvents(userId: string, timeMin: string, timeMax: string) {
    const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
    const allEvents: unknown[] = []

    for (const account of accounts) {
      let accessToken = account.accessToken
      const acct = account as any

      // Refresh token if expired
      if (acct.expiresAt && new Date() >= new Date(acct.expiresAt) && account.refreshToken) {
        const refreshed = await this.refreshGoogleToken(account.refreshToken)
        if (refreshed) {
          accessToken = refreshed.access_token
          await calendarRepo.updateAccount(account.id, {
            accessToken: refreshed.access_token,
            tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
          })
        }
      }

      for (const cal of account.calendars) {
        try {
          const calAny = cal as any
          const externalId = calAny.externalId || calAny.providerCalendarId
          const eventsUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(externalId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=250`

          const res = await fetch(eventsUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })

          if (res.ok) {
            const data = (await res.json()) as { items?: unknown[] }
            if (data.items) {
              allEvents.push(
                ...data.items.map((event: any) => ({
                  ...event,
                  // Use the provider id so DELETE/PATCH endpoints can resolve it.
                  calendarId: externalId,
                  internalCalendarId: cal.id,
                  calendarName: cal.name,
                  calendarColor: cal.color,
                  calendarAccessRole: (cal as any).accessRole ?? null,
                })),
              )
            }
          }
        } catch (err) {
          console.error(`[GOOGLE_EVENTS] Error fetching calendar ${cal.id}:`, err)
        }
      }
    }

    return allEvents
  }

  async importGoogleCalendar(userId: string) {
    return calendarRepo.findGoogleAccountWithRefreshToken(userId)
  }

  /**
   * Pull events from Google for the user's selected calendars and upsert them
   * into the local `CalendarEvent` cache. The scheduling engine reads that
   * cache as hard busy-block constraints, so without this, gap-finder sees
   * "nothing scheduled" even when the user has external meetings.
   *
   * - If `calendarId` is given, syncs only that one (must belong to user).
   * - Window: 7 days back to 60 days forward, expanding recurrences.
   * - Idempotent: relies on `upsertCalendarEventCache` (unique on
   *   calendarId + externalId).
   */
  async syncCalendars(userId: string, calendarId?: string) {
    const accounts = await calendarRepo.findAccountsWithSyncCalendars(userId)
    if (accounts.length === 0) return { success: true, count: 0, eventsSynced: 0 }

    const timeMin = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const timeMax = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString()

    let calendarsSynced = 0
    let eventsSynced = 0
    const errors: Array<{ calendarId: string; reason: string }> = []

    for (const account of accounts) {
      const accessToken = await this.ensureAccessToken(account.id)
      if (!accessToken) {
        for (const cal of account.calendars) {
          if (calendarId && cal.id !== calendarId) continue
          errors.push({ calendarId: cal.id, reason: 'no_access_token' })
        }
        continue
      }

      for (const cal of account.calendars) {
        if (calendarId && cal.id !== calendarId) continue
        const providerCalId = (cal as any).providerCalendarId || (cal as any).externalId
        if (!providerCalId) {
          errors.push({ calendarId: cal.id, reason: 'no_provider_id' })
          continue
        }

        // Look up an active watch channel; if it has a syncToken, prefer
        // incremental sync to avoid pulling the full 67-day window.
        const channel = await (prisma as any).calendarWatchChannel.findFirst({
          where: { calendarId: cal.id },
          orderBy: { createdAt: 'desc' },
        })

        try {
          const result = await this.pullCalendarEvents({
            calendarRowId: cal.id,
            providerCalId,
            accessToken,
            channel,
            timeMin,
            timeMax,
          })
          eventsSynced += result.eventsSynced
          calendarsSynced++
          if (result.error) errors.push({ calendarId: cal.id, reason: result.error })
        } catch (err) {
          errors.push({ calendarId: cal.id, reason: `exception:${(err as Error).message?.slice(0, 80)}` })
        }
      }
    }

    // Notify connected frontend tabs after sync completes
    syncService.publish(userId, {
      type: 'calendar.event.updated',
      payload: {},
    })

    return {
      success: errors.length === 0,
      count: calendarsSynced,
      eventsSynced,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /**
   * Pull events for a single calendar — incremental if the channel has a
   * `syncToken`, otherwise a full window pull. On 410 GONE (token invalidated
   * by Google) clears the token and retries as a full pull, then bootstraps a
   * fresh `nextSyncToken` at the end so subsequent calls can incremental again.
   */
  private async pullCalendarEvents(args: {
    calendarRowId: string
    providerCalId: string
    accessToken: string
    channel: { id: string; syncToken: string | null } | null
    timeMin: string
    timeMax: string
  }): Promise<{ eventsSynced: number; error?: string }> {
    const { calendarRowId, providerCalId, accessToken, channel, timeMin, timeMax } = args

    let pageToken: string | undefined
    let pages = 0
    let nextSyncToken: string | undefined
    let eventsSynced = 0
    let usingSyncToken = !!channel?.syncToken

    do {
      const params = new URLSearchParams({
        showDeleted: 'true',
        maxResults: '250',
      })
      if (usingSyncToken && channel?.syncToken && !pageToken) {
        params.set('syncToken', channel.syncToken)
      } else {
        params.set('singleEvents', 'true')
        params.set('orderBy', 'startTime')
        params.set('timeMin', timeMin)
        params.set('timeMax', timeMax)
      }
      if (pageToken) params.set('pageToken', pageToken)

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )

      // 410 GONE → syncToken invalidated. Clear it and retry from scratch as
      // a full window pull within this same call.
      if (res.status === 410 && usingSyncToken) {
        if (channel) {
          await (prisma as any).calendarWatchChannel.update({
            where: { id: channel.id },
            data: { syncToken: null },
          }).catch(() => undefined)
        }
        usingSyncToken = false
        pageToken = undefined
        pages = 0
        continue
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        return {
          eventsSynced,
          error: `list_${res.status}:${txt.slice(0, 80)}`,
        }
      }

      const body = (await res.json()) as {
        items?: any[]
        nextPageToken?: string
        nextSyncToken?: string
      }
      for (const evt of body.items ?? []) {
        await this.upsertCalendarEventCache(calendarRowId, evt).catch((e) =>
          console.error('[CAL_SYNC] upsert error', { calendarId: calendarRowId, eventId: evt?.id, error: e }),
        )
        eventsSynced++
      }
      pageToken = body.nextPageToken
      if (body.nextSyncToken) nextSyncToken = body.nextSyncToken
      pages++
    } while (pageToken && pages < 20)

    // Persist syncToken on the channel for the next incremental sync. If the
    // full-window pull didn't return one (Google withholds it on paginated
    // responses without a final non-paged page), bootstrap a fresh one.
    if (channel) {
      const tokenToStore =
        nextSyncToken ?? (await this.fetchInitialSyncToken(accessToken, providerCalId))
      if (tokenToStore) {
        await (prisma as any).calendarWatchChannel
          .update({ where: { id: channel.id }, data: { syncToken: tokenToStore } })
          .catch(() => undefined)
      }
    }

    return { eventsSynced }
  }

  /**
   * Free slots inside the user's working window for a date, that are at least
   * `duration` minutes long. Backed by gap-finder so the result is consistent
   * with what auto-schedule would actually pick: CalendarEvent cache (busy +
   * not declined) + existing WorkingSessions, expanded by the user's gap minutes.
   */
  async getFreeSlots(userId: string, date: string, duration: number) {
    const settings = await prisma.userSettings.findUnique({ where: { userId } })
    const tz = settings?.timezone ?? 'UTC'
    const gapMin = settings?.autoSchedulingGapMinutes ?? 5
    const day = ymdToLocalDayUtc(date, tz)

    const window = await getDayWindow(userId, null, day)
    if (!window) {
      // No working hours configured for this day → preserve legacy "no preferences" surface.
      const hasAnyHours = await prisma.workingHours.findFirst({ where: { userId } })
      if (!hasAnyHours) return { error: 'no_work_preferences' as const }
      return { freeSlots: [] }
    }

    const blocks = await collectBusyBlocks(userId, day, gapMin)
    const gaps = computeGaps(blocks, window.start, window.end)

    return {
      freeSlots: gaps
        .filter((g) => g.durationMinutes >= duration)
        .map((g) => ({
          start: g.start.toISOString(),
          end: g.end.toISOString(),
          durationMinutes: g.durationMinutes,
        })),
    }
  }

  /**
   * Free-time analytics across a date range. Backed by gap-finder.collectBusyBlocks
   * so the busy view matches what the scheduler sees: cached CalendarEvent rows
   * (excluding declined) plus existing WorkingSessions.
   */
  async analyzeFreeTime(
    userId: string,
    startDate: string,
    endDate: string,
    workStartHour = 8,
    workEndHour = 22,
  ) {
    const settings = await prisma.userSettings.findUnique({ where: { userId } })
    const tz = settings?.timezone ?? 'UTC'
    const gapMin = settings?.autoSchedulingGapMinutes ?? 0

    const totalWorkMinutesPerDay = (workEndHour - workStartHour) * 60
    const hh = `${String(workStartHour).padStart(2, '0')}:00`
    const eh = `${String(workEndHour).padStart(2, '0')}:00`

    const days: Array<{
      date: string
      totalFreeMinutes: number
      totalBusyMinutes: number
      longestFreeBlock: number
      freeSlots: Array<{ start: string; end: string; durationMinutes: number }>
      eventCount: number
    }> = []

    // Walk the range one local day at a time so each iteration anchors on a
    // unambiguous YMD in the user's tz.
    const startYmd = localYmd(new Date(startDate), tz)
    const endYmd = localYmd(new Date(endDate), tz)
    let cursor = ymdToLocalDayUtc(startYmd, tz)
    const stop = ymdToLocalDayUtc(endYmd, tz)

    while (cursor.getTime() <= stop.getTime()) {
      const dateStr = localYmd(cursor, tz)
      const dayStart = localTimeToUtc(cursor, hh, tz)
      const dayEnd = localTimeToUtc(cursor, eh, tz)

      const blocks = await collectBusyBlocks(userId, cursor, gapMin)
      const gaps = computeGaps(blocks, dayStart, dayEnd)

      const freeSlots = gaps.map((g) => ({
        start: g.start.toISOString(),
        end: g.end.toISOString(),
        durationMinutes: g.durationMinutes,
      }))
      const longestFreeBlock = freeSlots.reduce((m, s) => Math.max(m, s.durationMinutes), 0)
      const totalFreeMinutes = freeSlots.reduce((s, x) => s + x.durationMinutes, 0)
      // Count busy "events" inside the working window (events only, not sessions).
      const eventCount = blocks.filter(
        (b) => b.source === 'EVENT' && b.start < dayEnd && b.end > dayStart,
      ).length

      days.push({
        date: dateStr,
        totalFreeMinutes,
        totalBusyMinutes: Math.max(0, totalWorkMinutesPerDay - totalFreeMinutes),
        longestFreeBlock,
        freeSlots,
        eventCount,
      })

      // Advance to next local day at noon (DST-safe) and re-anchor.
      const nextYmd = localYmd(new Date(cursor.getTime() + 26 * 3600 * 1000), tz)
      if (nextYmd === dateStr) break // safety against bad tz / edge cases
      cursor = ymdToLocalDayUtc(nextYmd, tz)
    }

    // Build summary
    const avgFreeMinutesPerDay = days.length > 0
      ? Math.round(days.reduce((s, d) => s + d.totalFreeMinutes, 0) / days.length)
      : 0

    let busiestDay = days[0]?.date ?? startDate
    let freestDay = days[0]?.date ?? startDate
    let minFree = days[0]?.totalFreeMinutes ?? 0
    let maxFree = days[0]?.totalFreeMinutes ?? 0

    for (const d of days) {
      if (d.totalFreeMinutes < minFree) { minFree = d.totalFreeMinutes; busiestDay = d.date }
      if (d.totalFreeMinutes > maxFree) { maxFree = d.totalFreeMinutes; freestDay = d.date }
    }

    const totalFreeHours = Math.round(days.reduce((s, d) => s + d.totalFreeMinutes, 0) / 60 * 10) / 10

    return {
      days,
      summary: { avgFreeMinutesPerDay, busiestDay, freestDay, totalFreeHours },
    }
  }

  async createTimeBlock(
    userId: string,
    input: {
      title: string
      date: string
      startTime: string
      endTime: string
      description?: string
      color?: string
      timeZone?: string
      location?: string
      attendees?: { email: string }[]
      reminders?: {
        useDefault: boolean
        overrides?: { method: 'popup' | 'email'; minutes: number }[]
      }
      addGoogleMeet?: boolean
      calendarId?: string
    },
  ): Promise<{
    success: boolean
    eventId?: string
    hangoutLink?: string
    htmlLink?: string
    error?: string
  }> {
    // Get the user's primary Google Calendar account
    const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
    if (!accounts.length) return { success: false, error: 'no_google_account' }

    const account = accounts[0]!
    let accessToken = account.accessToken

    // Refresh token if needed
    const acct = account as any
    if (acct.expiresAt && new Date() >= new Date(acct.expiresAt) && account.refreshToken) {
      const refreshed = await this.refreshGoogleToken(account.refreshToken)
      if (refreshed) {
        accessToken = refreshed.access_token
        await calendarRepo.updateAccount(account.id, {
          accessToken: refreshed.access_token,
          tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
        })
      }
    }

    // Pick calendar — caller can specify, otherwise primary
    let targetCalendarId = input.calendarId
    if (!targetCalendarId) {
      const primaryCal = account.calendars.find((c: any) => c.isPrimary) || account.calendars[0]
      if (!primaryCal) return { success: false, error: 'no_calendar' }
      const calAny = primaryCal as any
      targetCalendarId = calAny.externalId || calAny.providerCalendarId
    }

    // Reject writes to read-only calendars (holiday, contacts, weather, etc.)
    const targetCal = account.calendars.find(
      (c: any) =>
        c.providerCalendarId === targetCalendarId ||
        c.externalId === targetCalendarId,
    )
    const role = (targetCal as any)?.accessRole as string | null | undefined
    if (role && role !== 'owner' && role !== 'writer') {
      return { success: false, error: 'calendar_read_only' }
    }

    // Create the event
    const startDateTime = `${input.date}T${input.startTime}:00`
    const endDateTime = `${input.date}T${input.endTime}:00`

    const tz = input.timeZone || 'UTC'
    const eventBody: Record<string, unknown> = {
      summary: input.title,
      description: input.description || 'Time block created by ThePrimeWay',
      start: { dateTime: startDateTime, timeZone: tz },
      end: { dateTime: endDateTime, timeZone: tz },
      colorId: input.color || '9', // Blueberry
    }
    if (input.location) eventBody.location = input.location
    if (input.attendees?.length) eventBody.attendees = input.attendees
    if (input.reminders) eventBody.reminders = input.reminders
    if (input.addGoogleMeet) {
      eventBody.conferenceData = {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolution: { key: { type: 'hangoutsMeet' } },
        },
      }
    }

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId!)}/events`,
    )
    if (input.addGoogleMeet) url.searchParams.set('conferenceDataVersion', '1')

    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventBody),
      })

      if (!res.ok) {
        const error = await res.text()
        console.error('[TIME_BLOCK] Failed to create event:', error)
        // Google returns 403 on read-only calendars (holidays, contacts, etc.)
        if (res.status === 403 || /forbidden|read[- ]?only/i.test(error)) {
          if (targetCal && (!role || (role !== 'owner' && role !== 'writer'))) {
            await calendarRepo
              .updateCalendar((targetCal as any).id, { accessRole: 'reader' })
              .catch(() => {})
          }
          return { success: false, error: 'calendar_read_only' }
        }
        return { success: false, error: 'event_creation_failed' }
      }

      const event = (await res.json()) as Record<string, any>
      // Write-through to local cache so the UI sees the new event on its next
      // refetch — without this, the user has to wait for a Google webhook
      // (which never fires in dev) or a manual sync.
      if (targetCal && event.id) {
        await this.upsertCalendarEventCache((targetCal as any).id, event).catch((err) =>
          console.error('[TIME_BLOCK] cache write-through failed', err),
        )
      }
      return {
        success: true,
        eventId: event.id,
        hangoutLink: event.hangoutLink,
        htmlLink: event.htmlLink,
      }
    } catch (err) {
      console.error('[TIME_BLOCK] Error:', err)
      return { success: false, error: 'event_creation_failed' }
    }
  }

  // -------------------------------------------------------------------------
  // Generic Google Event mutations (for arbitrary events, not Task-bound)
  // -------------------------------------------------------------------------

  /**
   * Verify the given calendarId belongs to the user and return an access token
   * for the owning account. Returns null if calendar not found for user.
   */
  private async resolveCalendarForUser(
    userId: string,
    calendarId: string,
  ): Promise<{ accessToken: string; calendar: any; account: any } | null> {
    const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
    for (const account of accounts) {
      const cal = (account.calendars as any[]).find(
        (c) => (c.providerCalendarId || c.externalId) === calendarId,
      )
      if (cal) {
        let accessToken = account.accessToken!
        const acct = account as any
        if (acct.expiresAt && new Date() >= new Date(acct.expiresAt) && account.refreshToken) {
          const refreshed = await this.refreshGoogleToken(account.refreshToken)
          if (refreshed) {
            accessToken = refreshed.access_token
            await calendarRepo.updateAccount(account.id, {
              accessToken: refreshed.access_token,
              tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
            })
          }
        }
        return { accessToken, calendar: cal, account }
      }
    }
    return null
  }

  async getGoogleEvent(
    userId: string,
    calendarId: string,
    eventId: string,
  ): Promise<{ success: boolean; event?: any; error?: string }> {
    const ctx = await this.resolveCalendarForUser(userId, calendarId)
    if (!ctx) return { success: false, error: 'not_found' }
    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
      )
      if (!res.ok) {
        return { success: false, error: `google_${res.status}` }
      }
      const event = await res.json()
      return { success: true, event }
    } catch (err) {
      console.error('[GET_EVENT] Error:', err)
      return { success: false, error: 'network_error' }
    }
  }

  async updateGoogleEvent(
    userId: string,
    calendarId: string,
    eventId: string,
    patch: {
      title?: string
      description?: string
      location?: string
      date?: string
      startTime?: string
      endTime?: string
      timeZone?: string
      colorId?: string
      attendees?: { email: string }[]
      addGoogleMeet?: boolean
      removeGoogleMeet?: boolean
      reminders?: {
        useDefault: boolean
        overrides?: { method: 'popup' | 'email'; minutes: number }[]
      }
      visibility?: 'default' | 'public' | 'private' | 'confidential'
    },
  ): Promise<{ success: boolean; event?: any; error?: string }> {
    const ctx = await this.resolveCalendarForUser(userId, calendarId)
    if (!ctx) return { success: false, error: 'not_found' }

    const body: Record<string, unknown> = {}
    if (patch.title !== undefined) body.summary = patch.title
    if (patch.description !== undefined) body.description = patch.description
    if (patch.location !== undefined) body.location = patch.location
    if (patch.colorId !== undefined) body.colorId = patch.colorId
    if (patch.attendees !== undefined) body.attendees = patch.attendees
    if (patch.reminders !== undefined) body.reminders = patch.reminders
    if (patch.visibility !== undefined) body.visibility = patch.visibility

    if (patch.date && patch.startTime && patch.endTime) {
      const tz = patch.timeZone || 'UTC'
      body.start = { dateTime: `${patch.date}T${patch.startTime}:00`, timeZone: tz }
      body.end = { dateTime: `${patch.date}T${patch.endTime}:00`, timeZone: tz }
    }

    let needsConferenceVersion = false
    if (patch.addGoogleMeet) {
      body.conferenceData = {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolution: { key: { type: 'hangoutsMeet' } },
        },
      }
      needsConferenceVersion = true
    } else if (patch.removeGoogleMeet) {
      body.conferenceData = null
      needsConferenceVersion = true
    }

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    )
    if (needsConferenceVersion) url.searchParams.set('conferenceDataVersion', '1')

    try {
      const res = await fetch(url.toString(), {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errText = await res.text()
        console.error('[UPDATE_EVENT] Failed:', errText)
        return { success: false, error: 'event_update_failed' }
      }
      const event = (await res.json()) as Record<string, any>
      // Write-through to local cache so the UI sees the change immediately.
      if (ctx.calendar?.id && event?.id) {
        await this.upsertCalendarEventCache(ctx.calendar.id, event).catch((err) =>
          console.error('[UPDATE_EVENT] cache write-through failed', err),
        )
      }
      return { success: true, event }
    } catch (err) {
      console.error('[UPDATE_EVENT] Error:', err)
      return { success: false, error: 'network_error' }
    }
  }

  async deleteGoogleEvent(
    userId: string,
    calendarId: string,
    eventId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const ctx = await this.resolveCalendarForUser(userId, calendarId)
    if (!ctx) return { success: false, error: 'not_found' }
    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ctx.accessToken}` },
        },
      )
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        const errText = await res.text()
        console.error('[DELETE_EVENT] Failed:', errText)
        return { success: false, error: 'event_delete_failed' }
      }
      // Write-through: remove from local cache so the UI reflects the deletion.
      if (ctx.calendar?.id) {
        await prisma.calendarEvent
          .deleteMany({ where: { calendarId: ctx.calendar.id, externalId: eventId } })
          .catch((err) => console.error('[DELETE_EVENT] cache write-through failed', err))
      }
      return { success: true }
    } catch (err) {
      console.error('[DELETE_EVENT] Error:', err)
      return { success: false, error: 'network_error' }
    }
  }

  async createHabitBlock(
    userId: string,
    input: {
      habitId: string
      habitName: string
      startTime: string
      endTime: string
      frequencyType: string
      weekDays?: string[]
      description?: string
      color?: string
    },
  ): Promise<{ success: boolean; eventId?: string; error?: string }> {
    // Get the user's primary Google Calendar account
    const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
    if (!accounts.length) return { success: false, error: 'no_google_account' }

    const account = accounts[0]!
    let accessToken = account.accessToken

    // Refresh token if needed
    const acct = account as any
    if (acct.expiresAt && new Date() >= new Date(acct.expiresAt) && account.refreshToken) {
      const refreshed = await this.refreshGoogleToken(account.refreshToken)
      if (refreshed) {
        accessToken = refreshed.access_token
        await calendarRepo.updateAccount(account.id, {
          accessToken: refreshed.access_token,
          tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
        })
      }
    }

    // Find primary calendar
    const primaryCal = account.calendars.find((c: any) => c.isPrimary) || account.calendars[0]
    if (!primaryCal) return { success: false, error: 'no_calendar' }

    const calAny = primaryCal as any
    const calendarId = calAny.externalId || calAny.providerCalendarId

    // Build RRULE based on frequency
    let rrule = ''
    if (input.frequencyType === 'daily') {
      rrule = 'RRULE:FREQ=DAILY'
    } else if (input.frequencyType === 'weekly' && input.weekDays?.length) {
      rrule = `RRULE:FREQ=WEEKLY;BYDAY=${input.weekDays.join(',')}`
    } else {
      rrule = 'RRULE:FREQ=DAILY'
    }

    // Start from tomorrow
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateStr = tomorrow.toISOString().split('T')[0]

    const colorMap: Record<string, string> = {
      tomato: '11', flamingo: '4', tangerine: '6', banana: '5',
      sage: '2', basil: '10', peacock: '7', blueberry: '9',
      lavender: '1', grape: '3', graphite: '8',
    }

    const eventBody: Record<string, unknown> = {
      summary: `🔄 ${input.habitName}`,
      description: input.description || `Habit: ${input.habitName}`,
      start: { dateTime: `${dateStr}T${input.startTime}:00`, timeZone: 'America/New_York' },
      end: { dateTime: `${dateStr}T${input.endTime}:00`, timeZone: 'America/New_York' },
      recurrence: [rrule],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
    }

    if (input.color && colorMap[input.color]) {
      eventBody.colorId = colorMap[input.color]
    }

    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(eventBody),
        },
      )

      if (!res.ok) {
        const error = await res.text()
        console.error('[CALENDAR_HABIT_BLOCK] Failed to create recurring event:', error)
        return { success: false, error: 'event_creation_failed' }
      }

      const event = (await res.json()) as { id: string }
      // Recurring events: Google returns the master, but the cache stores
      // expanded singleEvents instances. Trigger a background sync so the UI
      // sees individual occurrences in the visible range.
      this.syncCalendars(userId).catch((err) =>
        console.error('[CALENDAR_HABIT_BLOCK] post-create sync failed', err),
      )
      return { success: true, eventId: event.id }
    } catch (err) {
      console.error('[CALENDAR_HABIT_BLOCK] Error:', err)
      return { success: false, error: 'event_creation_failed' }
    }
  }

  /**
   * AI-driven day plan. The AI no longer discovers gaps — it receives
   * pre-computed gaps from gap-finder (the same source the scheduler uses)
   * and only assigns tasks to those slots. This eliminates the timezone bugs
   * the previous implementation had and keeps suggestions consistent with what
   * autoSchedule would actually accept.
   */
  async generateTimeBlocks(userId: string, date: string) {
    const settings = await prisma.userSettings.findUnique({ where: { userId } })
    const tz = settings?.timezone ?? 'UTC'
    const gapMin = settings?.autoSchedulingGapMinutes ?? 5
    const day = ymdToLocalDayUtc(date, tz)

    const window = await getDayWindow(userId, null, day)
    if (!window) return { blocks: [], unscheduled: [] }
    const dayStart = window.start
    const dayEnd = window.end

    const allOpenTasks = await tasksRepository.findMany(userId, {
      status: 'open',
      archivedAt: null,
    })

    // Candidate tasks = scheduled today, due today, or backlog (no schedule).
    const candidateTasks = allOpenTasks.filter((t: any) => {
      const scheduled = t.scheduledDate ? new Date(t.scheduledDate) : null
      const due = t.dueDate ? new Date(t.dueDate) : null
      if (scheduled && scheduled >= dayStart && scheduled <= dayEnd) return true
      if (due && due >= dayStart && due <= dayEnd) return true
      if (!scheduled && !due) return true
      return false
    })
    if (!candidateTasks.length) return { blocks: [], unscheduled: [] }

    const blocks = await collectBusyBlocks(userId, day, gapMin)
    const gaps = computeGaps(blocks, dayStart, dayEnd)

    const gapsText = gaps.length
      ? gaps
          .map((g, i) => `- gap ${i + 1}: ${g.start.toISOString()} → ${g.end.toISOString()} (${g.durationMinutes} min)`)
          .join('\n')
      : '(No free gaps inside working hours)'

    const tasksText = candidateTasks
      .map((t: any) => {
        const duration = t.estimatedDurationMinutes ?? 30
        const tags = Array.isArray(t.tags) ? (t.tags as string[]).join(', ') : ''
        return `- [${t.id}] "${t.title}" | priority: ${t.priority || 'medium'} | estimated: ${duration} min | tags: ${tags || 'none'} | due: ${t.dueDate ? new Date(t.dueDate).toISOString().split('T')[0] : 'none'}`
      })
      .join('\n')

    const timeBlockSchema = z.object({
      blocks: z.array(
        z.object({
          taskId: z.string().describe('Exact task ID from the list'),
          taskTitle: z.string().describe('Task title for display'),
          startTime: z.string().describe('Start time as ISO 8601 (within one of the provided gaps)'),
          endTime: z.string().describe('End time as ISO 8601 (within one of the provided gaps)'),
          reason: z.string().describe('Brief reason for this time slot'),
        }),
      ),
      unscheduled: z.array(
        z.object({
          taskId: z.string(),
          taskTitle: z.string(),
          reason: z.string(),
        }),
      ),
    })

    const result = await generateObject({
      model: taskModel,
      schema: timeBlockSchema,
      prompt: `You are a productivity scheduling assistant. Place tasks into the user's actually-free gaps for the day. Do NOT invent slots outside the provided gaps and do NOT overlap.

DATE (user's local day): ${date}
USER TIMEZONE: ${tz}
WORKING WINDOW (UTC): ${dayStart.toISOString()} → ${dayEnd.toISOString()}

FREE GAPS (use only these — they already exclude calendar events and existing sessions):
${gapsText}

TASKS TO PLACE:
${tasksText}

RULES:
1. Each task must fit fully inside one gap. Do not split a task across gaps.
2. startTime/endTime must be valid ISO 8601 timestamps INSIDE the listed gaps.
3. If a task is longer than every available gap, add it to "unscheduled" with a clear reason.
4. Prefer placing higher-priority tasks earlier in the day.
5. Group tasks with similar tags when both fit in adjacent gaps.
6. Return the EXACT task IDs from the list — do not invent IDs.
7. Order "blocks" chronologically.`,
    })

    return result.object
  }

  /**
   * AI-driven slot suggestions for a single task. Now feeds the AI the same
   * pre-computed gaps that auto-schedule would see (CalendarEvent cache +
   * existing WorkingSessions, in the user's tz). The AI's job is to score
   * and rank — not to discover availability.
   */
  async findSmartSlots(userId: string, taskId: string, date: string) {
    const task = await tasksRepository.findById(userId, taskId)
    if (!task) return { error: 'task_not_found' as const }

    const settings = await prisma.userSettings.findUnique({ where: { userId } })
    const tz = settings?.timezone ?? 'UTC'
    const gapMin = settings?.autoSchedulingGapMinutes ?? 5
    const day = ymdToLocalDayUtc(date, tz)

    const window = await getDayWindow(userId, (task as any).channelId ?? null, day)
    if (!window) {
      return {
        slots: [],
        bestSlot: { startTime: '', endTime: '', reason: 'No working hours configured for this day.' },
      }
    }

    const blocksForDay = await collectBusyBlocks(userId, day, gapMin)
    const allGaps = computeGaps(blocksForDay, window.start, window.end)
    const taskDuration = (task as any).estimatedDurationMinutes ?? 30
    const fittingGaps = allGaps.filter((g) => g.durationMinutes >= taskDuration)
    if (fittingGaps.length === 0) {
      return {
        slots: [],
        bestSlot: {
          startTime: '',
          endTime: '',
          reason: `No gap of ${taskDuration}+ minutes available for this task today.`,
        },
      }
    }

    // Productivity context (which UTC hours the user historically completes tasks in).
    const completedTasks = await tasksRepository.findCompletedWithActualStart(userId, 50)
    const hourCounts: Record<number, number> = {}
    for (const t of completedTasks) {
      if (!t.actualStart) continue
      const h = new Date(t.actualStart).getUTCHours()
      hourCounts[h] = (hourCounts[h] || 0) + 1
    }
    const sortedHours = Object.entries(hourCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([h, c]) => `${String(h).padStart(2, '0')}:00 UTC (${c} tasks)`)
      .slice(0, 5)
    const productivitySummary = sortedHours.length
      ? `Most productive hours: ${sortedHours.join(', ')}`
      : 'No historical productivity data available.'

    const taskTags = Array.isArray((task as any).tags) ? ((task as any).tags as string[]).join(', ') : ''
    const gapsText = fittingGaps
      .map((g, i) => `- candidate ${i + 1}: ${g.start.toISOString()} → ${g.end.toISOString()} (${g.durationMinutes} min)`)
      .join('\n')

    const smartSlotsSchema = z.object({
      slots: z.array(
        z.object({
          startTime: z.string().describe('Start time in ISO 8601 (must be inside one of the candidate gaps)'),
          endTime: z.string().describe('End time in ISO 8601 (must fit within the same gap)'),
          score: z.number().min(0).max(100),
          reason: z.string(),
        }),
      ),
      bestSlot: z.object({
        startTime: z.string(),
        endTime: z.string(),
        reason: z.string(),
      }),
    })

    const result = await generateObject({
      model: taskModel,
      schema: smartSlotsSchema,
      prompt: `You are a smart scheduling assistant. Score the user's free slots for this task — do NOT invent slots outside the provided candidates.

DATE (user's local day): ${date}
USER TIMEZONE: ${tz}
WORKING WINDOW (UTC): ${window.start.toISOString()} → ${window.end.toISOString()}

TASK:
- Title: "${task.title}"
- Priority: ${(task as any).priority || 'medium'}
- Estimated duration: ${taskDuration} minutes
- Tags: ${taskTags || 'none'}

CANDIDATE GAPS (only suggest slots inside these — exact ISO 8601):
${gapsText}

USER PRODUCTIVITY PATTERN:
${productivitySummary}

RULES:
1. Each slot must fit fully inside one candidate gap.
2. Each slot must last exactly ${taskDuration} minutes.
3. Suggest 3 to ${Math.min(5, fittingGaps.length)} slots, ranked by score (highest first).
4. Score 0-100 considering: priority+morning bias, deep-work mid-morning bias, productivity pattern overlap, buffer around adjacent gaps.
5. The bestSlot equals the highest-scored slot.
6. Use the EXACT ISO 8601 timestamps from the candidate gaps as starting points; never go outside them.`,
    })

    return result.object
  }

  // ---- Task ↔ Google Calendar bidirectional sync --------------------------

  /**
   * Ensure we have a fresh access token for the given account.
   * Mutates the DB if a refresh happens.
   */
  private async ensureAccessToken(accountId: string): Promise<string | null> {
    const account = await prisma.calendarAccount.findUnique({ where: { id: accountId } })
    if (!account?.accessToken) return null

    const expired = account.expiresAt && new Date() >= account.expiresAt
    if (!expired) return account.accessToken
    if (!account.refreshToken) return account.accessToken // best-effort

    const refreshed = await this.refreshGoogleToken(account.refreshToken)
    if (!refreshed) return account.accessToken

    await prisma.calendarAccount.update({
      where: { id: accountId },
      data: {
        accessToken: refreshed.access_token,
        expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      },
    })
    return refreshed.access_token
  }

  /**
   * Push a WorkingSession to Google Calendar.
   * Calendar resolution order:
   *   1. Channel.timeboxToCalendarId (per-channel target)
   *   2. CalendarAccount.defaultTargetCalendarId (user-level default)
   *   3. The user's primary selected-for-sync calendar
   * If none resolve, the session stays local and we return `no_target_calendar`.
   * Persists externalEventId / externalCalendarId on the session for later update/delete.
   */
  async pushSessionToCalendar(
    sessionId: string,
  ): Promise<{ ok: true; eventId: string } | { ok: false; reason: string }> {
    const session = await prisma.workingSession.findUnique({
      where: { id: sessionId },
      include: { task: true },
    })
    if (!session) return { ok: false, reason: 'session_not_found' }
    if (session.externalEventId) return { ok: true, eventId: session.externalEventId }

    // Try the channel binding first.
    let calendar: Awaited<ReturnType<typeof prisma.calendar.findUnique>> | null = null
    if (session.task?.channelId) {
      const channel = await prisma.channel.findUnique({ where: { id: session.task.channelId } })
      if (channel?.timeboxToCalendarId) {
        calendar = await prisma.calendar.findUnique({
          where: { id: channel.timeboxToCalendarId },
          include: { account: true },
        })
      }
    }

    // Fallback: account default / primary calendar for this user.
    if (!calendar) {
      const target = await calendarRepo.findTargetCalendarForUser(session.userId)
      if (!target) return { ok: false, reason: 'no_target_calendar' }
      calendar = await prisma.calendar.findUnique({
        where: { id: target.calendar.id },
        include: { account: true },
      })
    }
    if (!calendar) return { ok: false, reason: 'calendar_not_found' }

    const accessToken = await this.ensureAccessToken(calendar.calendarAccountId)
    if (!accessToken) return { ok: false, reason: 'no_access_token' }

    const userSettings = await prisma.userSettings.findUnique({
      where: { userId: session.userId },
      select: { timezone: true },
    })
    const tz = userSettings?.timezone ?? 'UTC'

    const body = {
      summary: session.task?.title ?? 'Working session',
      description: 'Auto-scheduled by ThePrimeWay',
      start: { dateTime: session.start.toISOString(), timeZone: tz },
      end: { dateTime: session.end.toISOString(), timeZone: tz },
      extendedProperties: { private: { theprimewaySessionId: session.id } },
    }
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.providerCalendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { ok: false, reason: `google_${res.status}:${txt.slice(0, 120)}` }
    }
    const data = (await res.json()) as { id?: string }
    if (!data.id) return { ok: false, reason: 'no_event_id' }

    await prisma.workingSession.update({
      where: { id: session.id },
      data: { externalCalendarId: calendar.id, externalEventId: data.id },
    })
    return { ok: true, eventId: data.id }
  }

  /** Remove a previously-pushed session from Google Calendar. Safe to call when unpushed. */
  async removeSessionFromCalendar(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    const session = await prisma.workingSession.findUnique({ where: { id: sessionId } })
    if (!session) return { ok: true }
    if (!session.externalEventId || !session.externalCalendarId) return { ok: true }
    const calendar = await prisma.calendar.findUnique({
      where: { id: session.externalCalendarId },
    })
    if (!calendar) return { ok: false, reason: 'calendar_not_found' }
    const accessToken = await this.ensureAccessToken(calendar.calendarAccountId)
    if (!accessToken) return { ok: false, reason: 'no_access_token' }
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.providerCalendarId)}/events/${encodeURIComponent(session.externalEventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    )
    // 410 Gone is fine (already deleted on Google)
    if (!res.ok && res.status !== 410 && res.status !== 404) {
      return { ok: false, reason: `google_${res.status}` }
    }
    await prisma.workingSession
      .update({ where: { id: session.id }, data: { externalEventId: null, externalCalendarId: null } })
      .catch(() => undefined)
    return { ok: true }
  }

  /** Patch an existing event with session's current start/end. If unpushed, push now. */
  async updateSessionOnCalendar(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    const session = await prisma.workingSession.findUnique({
      where: { id: sessionId },
      include: { task: true },
    })
    if (!session) return { ok: false, reason: 'session_not_found' }
    if (!session.externalEventId || !session.externalCalendarId) {
      const pushed = await this.pushSessionToCalendar(sessionId)
      return pushed.ok ? { ok: true } : { ok: false, reason: pushed.reason }
    }
    const calendar = await prisma.calendar.findUnique({ where: { id: session.externalCalendarId } })
    if (!calendar) return { ok: false, reason: 'calendar_not_found' }
    const accessToken = await this.ensureAccessToken(calendar.calendarAccountId)
    if (!accessToken) return { ok: false, reason: 'no_access_token' }

    const userSettings = await prisma.userSettings.findUnique({
      where: { userId: session.userId },
      select: { timezone: true },
    })
    const tz = userSettings?.timezone ?? 'UTC'

    const body = {
      start: { dateTime: session.start.toISOString(), timeZone: tz },
      end: { dateTime: session.end.toISOString(), timeZone: tz },
      summary: session.task?.title ?? 'Working session',
    }
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.providerCalendarId)}/events/${encodeURIComponent(session.externalEventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { ok: false, reason: `google_${res.status}:${txt.slice(0, 120)}` }
    }
    return { ok: true }
  }

  // -------------------------------------------------------------------------

  /**
   * Proactively refresh Google access tokens that expire in the next hour.
   * Reactive `ensureAccessToken` already covers the on-demand path, but if a
   * token expires between requests (e.g. overnight) the next push to Google
   * pays the latency of a refresh round-trip while the user waits. Running
   * this every 30 min keeps the pool warm.
   */
  async refreshExpiringGoogleTokens(): Promise<{
    refreshed: number
    failed: number
    skipped: number
  }> {
    const horizon = new Date(Date.now() + 60 * 60 * 1000)
    const accounts = await prisma.calendarAccount.findMany({
      where: {
        provider: 'google',
        refreshToken: { not: null },
        expiresAt: { lte: horizon },
      },
    })

    let refreshed = 0
    let failed = 0
    let skipped = 0
    for (const acc of accounts) {
      if (!acc.refreshToken) {
        skipped++
        continue
      }
      const tokens = await this.refreshGoogleToken(acc.refreshToken)
      if (!tokens) {
        failed++
        continue
      }
      await prisma.calendarAccount
        .update({
          where: { id: acc.id },
          data: {
            accessToken: tokens.access_token,
            expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          },
        })
        .catch((err) => {
          console.error('[CAL_TOKEN_REFRESH] update failed', { accountId: acc.id, err })
          failed++
        })
      refreshed++
    }
    return { refreshed, failed, skipped }
  }

  private async refreshGoogleToken(
    refreshToken: string,
  ): Promise<{ access_token: string; expires_in: number } | null> {
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.AUTH_GOOGLE_ID || '',
          client_secret: process.env.AUTH_GOOGLE_SECRET || '',
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      })

      if (!res.ok) return null
      return res.json() as Promise<{ access_token: string; expires_in: number }>
    } catch {
      return null
    }
  }

  // --- Watch channels (Google push notifications) --------------------------

  /**
   * Fetch a fresh `nextSyncToken` for a calendar via `events.list` with
   * `maxResults=1`. Google only returns `nextSyncToken` on the LAST page of a
   * paginated response, so a 1-result single-page request is the cheapest way
   * to bootstrap one. Returns null on any failure — caller can proceed without
   * a token (next webhook falls back to a 24h time window).
   */
  private async fetchInitialSyncToken(
    accessToken: string,
    providerCalId: string,
  ): Promise<string | null> {
    try {
      const params = new URLSearchParams({
        maxResults: '1',
        singleEvents: 'true',
        showDeleted: 'true',
        orderBy: 'startTime',
        timeMin: new Date().toISOString(),
      })
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!res.ok) return null
      const body = (await res.json()) as { nextSyncToken?: string; nextPageToken?: string }
      // If pagination is needed (rare for maxResults=1), Google withholds the
      // sync token until the final page; we don't loop because the payoff is
      // tiny — falling back to time-window pull on first webhook is fine.
      return body.nextSyncToken ?? null
    } catch {
      return null
    }
  }

  /**
   * Subscribe to push notifications for a given calendar.
   *
   * If `opts.initialSyncToken` is provided (e.g. preserved across a renewal),
   * it's stored on the new channel verbatim. Otherwise the function calls
   * `fetchInitialSyncToken` to bootstrap a fresh one so the very first webhook
   * can use incremental sync rather than the 24h time-window fallback.
   */
  async subscribeWatchChannel(
    calendarId: string,
    opts: { initialSyncToken?: string | null } = {},
  ): Promise<{ ok: boolean; reason?: string }> {
    const calendar = await calendarRepo.findCalendarById(calendarId)
    if (!calendar) return { ok: false, reason: 'calendar_not_found' }
    const account = await calendarRepo.findAccountByCalendarAccountId(calendar.calendarAccountId)
    if (!account) return { ok: false, reason: 'account_not_found' }

    const accessToken = await this.ensureAccessToken(account.id)
    if (!accessToken) return { ok: false, reason: 'no_access_token' }

    const webhookBase = process.env.GOOGLE_CALENDAR_WEBHOOK_URL || process.env.API_BASE_URL
    if (!webhookBase) return { ok: false, reason: 'no_webhook_url' }

    const channelId = crypto.randomUUID()
    const token = crypto.randomUUID()
    const providerCalId = (calendar as any).providerCalendarId || (calendar as any).externalId

    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events/watch`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: channelId,
            type: 'web_hook',
            address: `${webhookBase.replace(/\/$/, '')}/api/calendar/google/webhook`,
            token,
          }),
        },
      )
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        return { ok: false, reason: `watch_failed:${res.status}:${txt.slice(0, 120)}` }
      }
      const body = (await res.json()) as { resourceId: string; expiration: string }

      const syncToken =
        opts.initialSyncToken ?? (await this.fetchInitialSyncToken(accessToken, providerCalId))

      await (prisma as any).calendarWatchChannel.create({
        data: {
          calendarId: calendar.id,
          channelId,
          resourceId: body.resourceId,
          token,
          syncToken: syncToken ?? null,
          expiresAt: new Date(Number(body.expiration)),
        },
      })
      return { ok: true }
    } catch (err) {
      console.error('[CAL_WATCH] subscribe error', err)
      return { ok: false, reason: 'exception' }
    }
  }

  /** Handle an incoming webhook notification from Google. */
  async handleWatchNotification(headers: {
    channelId?: string
    resourceId?: string
    resourceState?: string
    token?: string
  }): Promise<{ ok: boolean; reason?: string }> {
    if (!headers.channelId) return { ok: false, reason: 'no_channel' }
    if (headers.resourceState === 'sync') return { ok: true } // initial handshake

    const channel = await (prisma as any).calendarWatchChannel.findUnique({
      where: { channelId: headers.channelId },
      include: { calendar: { include: { account: true } } },
    })
    if (!channel) return { ok: false, reason: 'channel_not_found' }
    if (channel.token && headers.token !== channel.token) return { ok: false, reason: 'bad_token' }

    const accessToken = await this.ensureAccessToken(channel.calendar.account.id)
    if (!accessToken) return { ok: false, reason: 'no_access_token' }

    const providerCalId =
      (channel.calendar as any).providerCalendarId || (channel.calendar as any).externalId
    const params = new URLSearchParams()
    if (channel.syncToken) params.set('syncToken', channel.syncToken)
    else params.set('timeMin', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    params.set('showDeleted', 'true')
    params.set('maxResults', '100')

    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalId)}/events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!res.ok) return { ok: false, reason: `list_failed:${res.status}` }
      const body = (await res.json()) as {
        items?: Array<any>
        nextSyncToken?: string
      }

      for (const evt of body.items || []) {
        await this.upsertCalendarEventCache(channel.calendarId, evt).catch((e) =>
          console.error('[CAL_WATCH] upsert event cache error', e),
        )
      }
      if (body.nextSyncToken) {
        await (prisma as any).calendarWatchChannel.update({
          where: { id: channel.id },
          data: { syncToken: body.nextSyncToken },
        })
      }
      // Notify connected frontend tabs so they refetch the calendar without polling
      syncService.publish(channel.calendar.account.userId, {
        type: 'calendar.event.updated',
        payload: {},
      })
      return { ok: true }
    } catch (err) {
      console.error('[CAL_WATCH] notification error', err)
      return { ok: false, reason: 'exception' }
    }
  }

  /**
   * Mirror a Google Calendar event into the local `CalendarEvent` cache.
   * Consumed by the scheduling engine as busy-block hard constraints AND by
   * the calendar UI (post-refactor `/google/events` reads from this table).
   *
   * Skips events we created ourselves from a `WorkingSession` (marked via
   * `extendedProperties.private.theprimewaySessionId`). Those are already
   * rendered by the UI from the `WorkingSession` table and the scheduler
   * sees them via `gap-finder.collectBusyBlocks`'s session branch — caching
   * them again would double-render in the time grid.
   */
  private async upsertCalendarEventCache(calendarId: string, evt: any) {
    if (!evt?.id) return
    if (evt.status === 'cancelled') {
      await prisma.calendarEvent.deleteMany({ where: { calendarId, externalId: evt.id } }).catch(() => undefined)
      return
    }
    if (evt.extendedProperties?.private?.theprimewaySessionId) return
    const startStr = evt.start?.dateTime ?? evt.start?.date
    const endStr = evt.end?.dateTime ?? evt.end?.date
    if (!startStr || !endStr) return
    const start = new Date(startStr)
    const end = new Date(endStr)
    const isAllDay = !evt.start?.dateTime
    // Google `transparency: transparent` = marked as Available (free) → not busy
    const isBusy = (evt.transparency ?? 'opaque') === 'opaque'
    // declined: user's attendee status is 'declined'
    const selfAttendee = (evt.attendees ?? []).find((a: any) => a?.self === true)
    const isDeclined = selfAttendee?.responseStatus === 'declined'

    const recurrence: string[] = Array.isArray(evt.recurrence) ? evt.recurrence : []
    const attendees =
      Array.isArray(evt.attendees) && evt.attendees.length > 0 ? evt.attendees : null
    const organizer = evt.organizer ?? null

    await prisma.calendarEvent.upsert({
      where: { calendarId_externalId: { calendarId, externalId: evt.id } },
      update: {
        title: evt.summary ?? '(untitled)',
        start,
        end,
        isBusy,
        isDeclined,
        isAllDay,
        colorId: evt.colorId ?? null,
        description: evt.description ?? null,
        location: evt.location ?? null,
        htmlLink: evt.htmlLink ?? null,
        hangoutLink: evt.hangoutLink ?? null,
        visibility: evt.visibility ?? null,
        recurringEventId: evt.recurringEventId ?? null,
        recurrence,
        attendees,
        organizer,
        syncedAt: new Date(),
      },
      create: {
        calendarId,
        externalId: evt.id,
        title: evt.summary ?? '(untitled)',
        start,
        end,
        isBusy,
        isDeclined,
        isAllDay,
        colorId: evt.colorId ?? null,
        description: evt.description ?? null,
        location: evt.location ?? null,
        htmlLink: evt.htmlLink ?? null,
        hangoutLink: evt.hangoutLink ?? null,
        visibility: evt.visibility ?? null,
        recurringEventId: evt.recurringEventId ?? null,
        recurrence,
        attendees,
        organizer,
      },
    })
  }

  /**
   * Renew watch channels expiring within 24h.
   *
   * Preserves the existing `syncToken` so incremental sync is uninterrupted
   * across renewals. Without this, every renewal would reset to the 24h
   * fallback and miss events older than that window.
   */
  async renewExpiringWatchChannels(): Promise<{ renewed: number; failed: number }> {
    const soon = new Date(Date.now() + 24 * 3600 * 1000)
    const channels = await (prisma as any).calendarWatchChannel.findMany({
      where: { expiresAt: { lte: soon } },
    })
    let renewed = 0
    let failed = 0
    for (const ch of channels) {
      const res = await this.subscribeWatchChannel(ch.calendarId, {
        initialSyncToken: ch.syncToken ?? null,
      })
      if (res.ok) {
        await (prisma as any).calendarWatchChannel.delete({ where: { id: ch.id } })
        renewed++
      } else {
        failed++
      }
    }
    return { renewed, failed }
  }

  /**
   * One-shot reactivation of push notifications for a user. For each
   * `isSelectedForSync` calendar, drops any existing watch channels that lack
   * a `syncToken` (or are already expired) and creates a fresh one with a
   * bootstrapped token. Channels that are healthy (have token, not expired)
   * are left alone.
   *
   * Used after configuration changes such as setting `GOOGLE_CALENDAR_WEBHOOK_URL`
   * or after the cache-mode→DB-mode migration left users without working
   * channels.
   */
  async resubscribeWatchChannelsForUser(
    userId: string,
  ): Promise<{ recreated: number; kept: number; failed: number }> {
    const accounts = await calendarRepo.findGoogleAccountsWithSyncCalendars(userId)
    let recreated = 0
    let kept = 0
    let failed = 0
    const now = new Date()

    for (const account of accounts) {
      for (const cal of account.calendars) {
        const calId = (cal as any).id
        const isSelected = (cal as any).isSelectedForSync === true
        if (!isSelected) continue

        const existing = await (prisma as any).calendarWatchChannel.findFirst({
          where: { calendarId: calId },
          orderBy: { createdAt: 'desc' },
        })

        const healthy =
          existing && existing.syncToken && existing.expiresAt && existing.expiresAt > now
        if (healthy) {
          kept++
          continue
        }

        // Drop any stale channels for this calendar before creating a new one
        // so we don't accumulate dead rows.
        await (prisma as any).calendarWatchChannel
          .deleteMany({ where: { calendarId: calId } })
          .catch(() => undefined)

        const res = await this.subscribeWatchChannel(calId)
        if (res.ok) recreated++
        else failed++
      }
    }

    return { recreated, kept, failed }
  }

  /**
   * List cached CalendarEvent rows in [from, to] for the user, in a shape the
   * web client already understands (the same defensive normalization in
   * `use-calendar-items.ts` handles both the raw Google shape and this
   * cache-derived shape). Triggers a background sync if no events are cached
   * AND the user has selected calendars — protects fresh users whose first
   * call would otherwise see "no events" until the next webhook fires.
   */
  async listCachedEventsForUi(userId: string, from: Date, to: Date) {
    const events = await prisma.calendarEvent.findMany({
      where: {
        calendar: { account: { userId } },
        start: { lt: to },
        end: { gt: from },
        isDeclined: false,
      },
      include: {
        calendar: { select: { id: true, name: true, color: true, providerCalendarId: true, accessRole: true } },
      },
      orderBy: { start: 'asc' },
    })

    // Fire-and-forget pull when:
    //   (a) cache is empty (fresh user), or
    //   (b) most recent event was synced > 5 min ago (webhook may have failed
    //       silently or env without a public URL has no webhook at all).
    // The current request still returns whatever's cached without waiting; the
    // *next* request sees fresh data once the sync completes.
    const STALE_AFTER_MS = 5 * 60 * 1000
    let isStale = events.length === 0
    if (!isStale) {
      const newest = events.reduce((max, e: any) => {
        const t = e.syncedAt ? new Date(e.syncedAt).getTime() : 0
        return t > max ? t : max
      }, 0)
      isStale = newest === 0 || Date.now() - newest > STALE_AFTER_MS
    }
    if (isStale) {
      this.syncCalendars(userId).catch((err) =>
        console.error('[CAL_LIST] background sync failed', err),
      )
    }

    return events.map((e: any) => ({
      id: e.externalId,
      summary: e.title,
      title: e.title,
      startTime: e.start.toISOString(),
      endTime: e.end.toISOString(),
      start: { dateTime: e.start.toISOString() },
      end: { dateTime: e.end.toISOString() },
      isAllDay: e.isAllDay,
      isBusy: e.isBusy,
      colorId: e.colorId ?? null,
      description: e.description ?? null,
      location: e.location ?? null,
      htmlLink: e.htmlLink ?? null,
      hangoutLink: e.hangoutLink ?? null,
      visibility: e.visibility ?? null,
      recurringEventId: e.recurringEventId ?? null,
      recurrence: e.recurrence ?? [],
      attendees: e.attendees ?? null,
      organizer: e.organizer ?? null,
      calendarId: e.calendar?.providerCalendarId ?? null,
      internalCalendarId: e.calendar?.id ?? e.calendarId,
      calendarName: e.calendar?.name ?? null,
      calendarColor: e.calendar?.color ?? null,
      calendarAccessRole: e.calendar?.accessRole ?? null,
    }))
  }

  /** List cached CalendarEvent rows for [from, to] that are not declined. */
  async listEventsInRange(userId: string, from: Date, to: Date) {
    return prisma.calendarEvent.findMany({
      where: {
        calendar: { account: { userId } },
        start: { lt: to },
        end: { gt: from },
        isDeclined: false,
      },
      select: {
        id: true,
        calendarId: true,
        externalId: true,
        title: true,
        start: true,
        end: true,
        isBusy: true,
        isAllDay: true,
      },
      orderBy: { start: 'asc' },
    })
  }
}

export const calendarService = new CalendarService()
