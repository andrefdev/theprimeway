// ============================================================
// USUARIO Y AUTH
// ============================================================

export interface User {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

export interface UserProfile {
  id: string;
  userId: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  profilePicture?: string;
  bio?: string;
  primaryGoal?: string;
}

export interface UserSettings {
  locale: 'en' | 'es';
  theme: 'light' | 'dark';
  timezone: string;
  aiDataSharing: boolean;
}

export interface UserWorkPreferences {
  timeZone: string;
  workStartHour: number;
  workEndHour: number;
  workDays?: number[];
  defaultTaskDurationMinutes?: number;
  maxTasksPerDay?: number;
  overflowStrategy?: string;
}

// ============================================================
// TAREAS
// ============================================================

export type TaskStatus = 'open' | 'completed';
export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskSource = 'manual' | 'autoschedule' | 'dragged' | 'recovered';

export interface Task {
  id: string;
  userId?: string;
  weeklyGoalId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: string;
  completedAt?: string;
  tags: string[];
  estimatedDurationMinutes?: number;
  actualDurationMinutes?: number;
  scheduledDate?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  actualStart?: string;
  actualEnd?: string;
  isAllDay?: boolean;
  source?: TaskSource;
  backlogState?: string;
  lockedTime?: boolean;
  orderInDay?: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// HÁBITOS
// ============================================================

export type FrequencyType = 'daily' | 'weekly';

export interface Habit {
  id: string;
  name: string;
  description?: string;
  category?: string;
  color: string;
  targetFrequency: number;
  frequencyType?: FrequencyType;
  weekDays?: number[];
  isActive: boolean;
  createdAt: string;
}

export interface HabitLog {
  id: string;
  habitId: string;
  userId: string;
  date: string;
  completedCount: number;
  notes?: string;
}

// ============================================================
// METAS (PRIME ROADMAP)
// ============================================================

export type PillarArea =
  | 'finances'
  | 'career'
  | 'health'
  | 'relationships'
  | 'mindset'
  | 'lifestyle';

export interface PrimeVision {
  id: string;
  title: string;
  narrative?: string;
  status: string;
  pillars: PrimePillar[];
}

export interface PrimePillar {
  id: string;
  visionId?: string;
  area: PillarArea;
  title: string;
  description?: string;
  outcomes: PrimeOutcome[];
  annualGoals?: PrimeOutcome[];
}

export interface PrimeOutcome {
  id: string;
  pillarId?: string;
  threeYearGoalId?: string;
  title: string;
  description?: string;
  targetDate?: string;
  progress: number;
  focuses: PrimeQuarterFocus[];
}

export interface PrimeQuarterFocus {
  id: string;
  outcomeId?: string;
  annualGoalId?: string;
  year: number;
  quarter: number;
  title: string;
  objectives?: Record<string, unknown>;
  startDate?: string;
  endDate?: string;
  progress: number;
}

export interface WeeklyGoal {
  id: string;
  quarterFocusId?: string;
  quarterlyGoalId?: string;
  weekStartDate: string;
  title: string;
  description?: string;
  status: 'planned' | 'in_progress' | 'completed' | 'canceled';
  order: number;
}

// Aliases for the PRD-renamed 5-level hierarchy (Vision → ThreeYear → Annual → Quarterly → Weekly)
export type ThreeYearGoal = PrimePillar;
export type AnnualGoal = PrimeOutcome;
export type QuarterlyGoal = PrimeQuarterFocus;

// ============================================================
// SUSCRIPCIÓN
// ============================================================

export interface SubscriptionPlan {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  price: number;
  currency: string;
  billingInterval: 'monthly' | 'yearly';
  maxHabits?: number;
  maxGoals?: number;
  maxTasks?: number;
  hasAiAssistant?: boolean;
  hasAdvancedAnalytics?: boolean;
}

export interface UserSubscription {
  id: string;
  planId?: string;
  status?: 'pending' | 'active' | 'paused' | 'cancelled' | 'expired';
  trialEndsAt?: string;
  endsAt?: string;
  nextBillingDate?: string;
  plan?: SubscriptionPlan;
}

// ============================================================
// NOTIFICACIONES
// ============================================================

export interface NotificationPreferences {
  habitReminders: boolean;
  pomodoroAlerts: boolean;
  taskReminders: boolean;
  dailyMotivation: boolean;
  marketingMessages: boolean;
}

// ============================================================
// CALENDARIO
// ============================================================

export interface CalendarAccount {
  id: string;
  provider: string;
  email: string;
  isConnected: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startDate: string;
  endDate: string;
  isAllDay: boolean;
  color?: string;
  calendarId?: string;
}

// ============================================================
// AI CHAT
// ============================================================

export interface AiThread {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

// ============================================================
// AUTH
// ============================================================

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  name: string;
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  refreshToken?: string;
  user: User;
}
