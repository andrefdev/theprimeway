import { OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import { cronService } from '../services/cron.service'
import { renewExpiringWatchChannels } from '../services/calendar/google-watch.service'
import { refreshExpiringGoogleTokens } from '../services/calendar/google-account.service'
import { recurringService } from '../services/recurring.service'
import { ritualsService } from '../services/rituals.service'

export const cronRoutes = new OpenAPIHono()

// ---------------------------------------------------------------------------
// Cron Auth Middleware
// ---------------------------------------------------------------------------
const cronAuthMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization') || c.req.header('authorization')
  if (process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`) {
    await next()
    return
  }

  const apiKey = c.req.header('X-API-Key') || c.req.header('x-api-key')
  if (process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
    await next()
    return
  }

  return c.json({ error: 'Unauthorized' }, 401)
})

cronRoutes.use('*', cronAuthMiddleware)

// POST /daily-motivation
cronRoutes.post('/daily-motivation', async (c) => {
  try {
    const result = await cronService.sendDailyMotivation()
    return c.json(result)
  } catch (error) {
    console.error('[CRON_DAILY_MOTIVATION]', error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

// GET & POST /reminders
const handleReminders = async (c: any) => {
  try {
    const now = new Date()
    const result = await cronService.processReminders(now)
    return c.json(result)
  } catch (error) {
    console.error('[CRON_REMINDERS]', error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
}

cronRoutes.get('/reminders', handleReminders)
cronRoutes.post('/reminders', handleReminders)

// POST /habit-reminders
cronRoutes.post('/habit-reminders', async (c) => {
  try {
    const now = new Date()
    const result = await cronService.processHabitRemindersOnly(now)
    return c.json({ success: true, ...result })
  } catch (error) {
    console.error('[CRON_HABIT_REMINDERS]', error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

// POST /quarterly-review
cronRoutes.post('/quarterly-review', async (c) => {
  try {
    const result = await cronService.processQuarterlyReview()
    return c.json({ data: result }, 200)
  } catch (err: any) {
    console.error('[CRON_QUARTERLY_REVIEW]', err)
    return c.json({ error: err.message || 'Failed to process quarterly review' }, 500)
  }
})

// POST /weekly-review
cronRoutes.post('/weekly-review', async (c) => {
  try {
    const result = await cronService.processWeeklyReview()
    return c.json({ data: result }, 200)
  } catch (err: any) {
    console.error('[CRON_WEEKLY_REVIEW]', err)
    return c.json({ error: err.message || 'Failed to process weekly review' }, 500)
  }
})

// POST /calendar-watch-renew
cronRoutes.post('/calendar-watch-renew', async (c) => {
  try {
    const result = await renewExpiringWatchChannels()
    return c.json({ data: result }, 200)
  } catch (err: any) {
    console.error('[CRON_CAL_WATCH_RENEW]', err)
    return c.json({ error: err.message || 'Failed' }, 500)
  }
})

// POST /refresh-google-tokens — schedule every 30min to keep tokens warm.
cronRoutes.post('/refresh-google-tokens', async (c) => {
  try {
    const result = await refreshExpiringGoogleTokens()
    return c.json({ data: result }, 200)
  } catch (err: any) {
    console.error('[CRON_GOOGLE_TOKEN_REFRESH]', err)
    return c.json({ error: err.message || 'Failed' }, 500)
  }
})

// POST /materialize-daily — ensure daily rituals + materialize recurring series
cronRoutes.post('/materialize-daily', async (c) => {
  try {
    const now = new Date()
    const [rituals, recurring] = await Promise.all([
      ritualsService.ensureDailyForAllUsers(now),
      recurringService.materializeForAllUsers(now),
    ])
    return c.json({ data: { rituals, recurring } }, 200)
  } catch (err: any) {
    console.error('[CRON_MATERIALIZE_DAILY]', err)
    return c.json({ error: err.message || 'Failed' }, 500)
  }
})

// POST /quarterly-nudge
cronRoutes.post('/quarterly-nudge', async (c) => {
  try {
    const result = await cronService.processQuarterlyNudge()
    return c.json({ data: result }, 200)
  } catch (err: any) {
    console.error('[CRON_QUARTERLY_NUDGE]', err)
    return c.json({ error: err.message || 'Failed to process quarterly nudge' }, 500)
  }
})

// POST /brain-cluster — re-cluster concept graphs for users overdue for refresh
cronRoutes.post('/brain-cluster', async (c) => {
  try {
    const result = await cronService.processBrainClusterRefresh()
    return c.json({ data: result }, 200)
  } catch (err: any) {
    console.error('[CRON_BRAIN_CLUSTER]', err)
    return c.json({ error: err.message || 'Failed' }, 500)
  }
})

// POST /monthly-commissions — accrue ambassador commissions for the period
import { commissionService } from '../services/commission.service'
cronRoutes.post('/monthly-commissions', async (c) => {
  try {
    const period = c.req.query('period') || undefined
    const result = await commissionService.runMonthlyJob(period)
    return c.json({ data: result }, 200)
  } catch (err: any) {
    console.error('[CRON_MONTHLY_COMMISSIONS]', err)
    return c.json({ error: err.message || 'Failed' }, 500)
  }
})
