// Auth
export const AUTH = {
  LOGIN: '/api/auth/login',
  REGISTER: '/api/auth/register',
  OAUTH: '/api/auth/oauth',
  REFRESH: '/api/auth/refresh',
  LOGOUT: '/api/auth/logout',
  ME: '/api/auth/me',
  VERIFY_EMAIL: '/api/auth/verify-email',
  RESEND_OTP: '/api/auth/resend-otp',
  FORGOT_PASSWORD: '/api/auth/forgot-password',
  RESET_PASSWORD: '/api/auth/reset-password',
  REQUEST_ACCOUNT_DELETION: '/api/auth/request-account-deletion',
  CONFIRM_ACCOUNT_DELETION: '/api/auth/confirm-account-deletion',
} as const;

// Tasks
export const TASKS = {
  BASE: '/api/tasks',
  GROUPED: '/api/tasks/grouped',
  BY_ID: (id: string) => `/api/tasks/${id}`,
  SCHEDULE: (id: string) => `/api/tasks/${id}/schedule`,
  AUTO_ARCHIVE: '/api/tasks/auto-archive',
} as const;

// Habits
export const HABITS = {
  BASE: '/api/habits',
  BY_ID: (id: string) => `/api/habits/${id}`,
  LOGS: (id: string) => `/api/habits/${id}/logs`,
  STATS: '/api/habits/stats',
} as const;

// AI
export const AI = {
  CHAT: '/api/chat',
  THREADS: '/api/ai/threads',
  BRIEFING: '/api/chat/briefing',
  WEEKLY_PLAN: '/api/chat/weekly-plan',
} as const;

// Brain (second brain)
export const BRAIN = {
  ENTRIES: '/api/brain/entries',
} as const;

// Goals (vision → 3yr → annual → quarterly → weekly)
export const GOALS = {
  THREE_YEAR: '/api/goals/three-year',
  THREE_YEAR_BY_ID: (id: string) => `/api/goals/three-year/${id}`,
  ANNUAL: '/api/goals/annual',
  ANNUAL_BY_ID: (id: string) => `/api/goals/annual/${id}`,
  QUARTERLY: '/api/goals/quarterly',
  QUARTERLY_BY_ID: (id: string) => `/api/goals/quarterly/${id}`,
  WEEKLY_BY_ID: (id: string) => `/api/goals/weekly/${id}`,
} as const;

// Calendar (Google Calendar bridge)
export const CALENDAR = {
  TIME_BLOCK: '/api/calendar/time-block',
  HABIT_BLOCK: '/api/calendar/habit-block',
  EVENT: (calendarId: string, eventId: string) =>
    `/api/calendar/events/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`,
} as const;

// Pomodoro
export const POMODORO = {
  SESSIONS: '/api/pomodoro/sessions',
} as const;

// Scheduling (auto-schedule, deconflict, etc.)
export const SCHEDULING = {
  AUTO_SCHEDULE: '/api/scheduling/auto-schedule',
} as const;

// Profile & Settings
export const USER = {
  PROFILE: '/api/profile',
  SETTINGS: '/api/user/settings',
  CURRENCY_SETTINGS: '/api/user/currency-settings',
  WORK_PREFERENCES: '/api/user/work-preferences',
  ONBOARDING: '/api/user/onboarding',
} as const;

// Notifications
export const NOTIFICATIONS = {
  REGISTER: '/api/notifications/register',
  PREFERENCES: '/api/notifications/preferences',
  AGGREGATED: '/api/notifications/aggregated',
} as const;

// Gamification
export const GAMIFICATION = {
  PROFILE: '/api/gamification/profile',
  PROFILE_SETTINGS: '/api/gamification/profile/settings',
  XP: '/api/gamification/xp',
  XP_HISTORY: '/api/gamification/xp/history',
  XP_DAILY: '/api/gamification/xp/daily',
  STREAK: '/api/gamification/streak',
  ACHIEVEMENTS: '/api/gamification/achievements',
  CHALLENGES: '/api/gamification/challenges',
  CHALLENGES_PROGRESS: '/api/gamification/challenges/progress',
  SEED: '/api/gamification/seed',
} as const;

// Features
export const FEATURES = {
  RESOLVED: '/api/features',
} as const;
