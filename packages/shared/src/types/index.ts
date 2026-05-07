// Shared types across web, api, and mobile

export type { User, UserProfile, UserSettings } from './user'
export type { Task, TaskStatus, TaskPriority, TaskBucket, GetTasksParams, TasksGroupedResponse } from './task'
export type { Habit, HabitLog, HabitStats } from './habit'
export type {
  PrimeVision,
  ThreeYearGoal,
  PrimePillar,
  AnnualGoal,
  PrimeOutcome,
  QuarterlyGoal,
  QuarterFocus,
  KeyResult,
  WeeklyGoal,
  WeeklyGoalStatus,
  FocusLink,
} from './goal'
export type { ApiResponse, PaginatedResponse, ApiError } from './api'
export type { PomodoroSession, PomodoroStats, PomodoroDailyStat } from './pomodoro'
export type {
  GamificationProfile,
  XpEvent,
  DailyXpSnapshot,
  Achievement,
  UserAchievement,
  DailyChallenge,
} from './gamification'
export type { CalendarAccount, CalendarInfo, CalendarEvent } from './calendar'
export type { ChatThread, ChatMessage } from './chat'
export type { NotificationPreferences, PushSubscription, AppNotification, SmartReminder, BatchedNotification, BatchedNotificationsResponse } from './notifications'
export type { SubscriptionPlan, SubscriptionStatus } from './subscriptions'
export type { FeatureValue, ResolvedFeatureSet, FeaturesResponse } from './features'
export type {
  BrainEntry,
  BrainEntryStatus,
  BrainCrossLink,
  BrainCrossLinkTarget,
  BrainCrossLinkType,
  BrainActionItem,
  BrainConceptKind,
  BrainConceptNode,
  BrainEdgeRelationType,
  BrainConceptEdgeDto,
  BrainClusterDto,
  BrainGraphResponse,
  BrainEgoNetworkResponse,
} from './brain'
