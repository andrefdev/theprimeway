import { api } from '@/shared/lib/api-client'

export interface Calendar {
  id: string
  calendarAccountId: string
  providerCalendarId: string
  name: string
  color?: string | null
  isPrimary?: boolean | null
  isSelectedForSync?: boolean | null
  accessRole?: string | null
}

export interface CalendarAccount {
  id: string
  provider: string
  email: string | null
  isPrimary?: boolean | null
  defaultTargetCalendarId?: string | null
  calendars?: Calendar[]
}

interface CalendarEvent {
  id: string
  title: string
  description?: string
  startTime: string
  endTime: string
  isAllDay: boolean
  location?: string
}

interface ListResponse<T> {
  data: T[]
  count: number
}

export interface UpdateCalendarBody {
  isSelectedForSync?: boolean
  isPrimary?: boolean
  color?: string
}

export interface UpdateAccountBody {
  defaultTargetCalendarId?: string | null
}

export interface CreateTimeBlockInput {
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
}

export interface CreateTimeBlockResult {
  success: boolean
  eventId?: string
  hangoutLink?: string
  htmlLink?: string
}

export interface UpdateGoogleEventBody {
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
}

export interface CreateHabitBlockInput {
  habitId: string
  habitName: string
  startTime: string
  endTime: string
  frequencyType: string
  weekDays?: string[]
  description?: string
  color?: string
}

export interface CreateHabitBlockResult {
  success: boolean
  eventId?: string
}

export interface FreeSlot {
  start: string
  end: string
  durationMinutes: number
}

export interface SmartSlot {
  start: string
  end: string
  startTime?: string
  endTime?: string
  score?: number
  reason?: string
}

export interface SmartSlotsResult {
  slots: SmartSlot[]
  bestSlot: SmartSlot | null
}

export interface FreeTimeAnalysis {
  // Backend returns AI analysis — keep loose since shape is dynamic
  [key: string]: unknown
}

export interface TimeBlocksAnalysis {
  [key: string]: unknown
}

export interface ConnectGoogleResult {
  success?: boolean
  accountId?: string
  [key: string]: unknown
}

export const calendarApi = {
  listAccounts: () =>
    api.get<{ data: CalendarAccount[] }>('/calendar/accounts').then((r) => r.data.data),

  deleteAccount: (id: string) =>
    api.delete(`/calendar/accounts`, { params: { id } }).then((r) => r.data),

  updateAccount: (id: string, body: UpdateAccountBody) =>
    api
      .patch<{ data: CalendarAccount }>(`/calendar/accounts/${id}`, body)
      .then((r) => r.data.data),

  updateCalendar: (id: string, body: UpdateCalendarBody) =>
    api.patch<{ data: Calendar }>(`/calendar/calendars/${id}`, body).then((r) => r.data.data),

  getGoogleConnectUrl: () =>
    api.get<{ url: string }>('/calendar/google/connect').then((r) => r.data),

  connectGoogle: (code: string) =>
    api
      .post<{ data: ConnectGoogleResult }>('/calendar/google/callback', { code })
      .then((r) => r.data.data),

  getGoogleEvents: (params?: Record<string, string>) =>
    api.get<ListResponse<CalendarEvent>>('/calendar/google/events', { params }).then((r) => r.data),

  sync: () => api.post<{ success?: boolean }>('/calendar/sync').then((r) => r.data),

  resubscribe: () =>
    api
      .post<{ data: { recreated: number; kept: number; failed: number } }>('/calendar/resubscribe')
      .then((r) => r.data.data),

  createTimeBlock: (input: CreateTimeBlockInput) =>
    api
      .post<{ data: CreateTimeBlockResult }>('/calendar/time-block', input)
      .then((r) => r.data.data),

  getGoogleEvent: (calendarId: string, eventId: string) =>
    api
      .get<{ data: CalendarEvent }>(
        `/calendar/events/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`,
      )
      .then((r) => r.data.data),

  updateGoogleEvent: (calendarId: string, eventId: string, body: UpdateGoogleEventBody) =>
    api
      .patch<{ data: CalendarEvent }>(
        `/calendar/events/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`,
        body,
      )
      .then((r) => r.data.data),

  deleteGoogleEvent: (calendarId: string, eventId: string) =>
    api
      .delete<{ data: { success: boolean } }>(
        `/calendar/events/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`,
      )
      .then((r) => r.data.data),

  createHabitBlock: (input: CreateHabitBlockInput) =>
    api
      .post<{ data: CreateHabitBlockResult }>('/calendar/habit-block', input)
      .then((r) => r.data.data),

  getFreeSlots: (date: string, duration: number) =>
    api
      .get<{ freeSlots: FreeSlot[] }>('/calendar/free-slots', {
        params: { date, duration: String(duration) },
      })
      .then((r) => r.data),

  analyzeFreeTime: (start: string, end: string) =>
    api
      .get<{ data: FreeTimeAnalysis }>('/calendar/free-time', { params: { start, end } })
      .then((r) => r.data.data),

  getTimeBlocks: (date: string) =>
    api
      .get<{ data: TimeBlocksAnalysis }>('/calendar/ai/time-blocks', { params: { date } })
      .then((r) => r.data.data),

  findSmartSlots: (taskId: string, date: string) =>
    api
      .get<{ data: SmartSlotsResult }>('/calendar/ai/smart-slots', { params: { taskId, date } })
      .then((r) => r.data.data),
}
