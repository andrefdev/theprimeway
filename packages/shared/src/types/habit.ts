export interface Habit {
  id: string
  userId: string
  name: string
  description: string | null
  category: string | null
  color: string | null
  targetFrequency: number
  frequencyType: 'daily' | 'week_days' | 'times_per_week'
  weekDays: number[]
  isActive: boolean
  createdAt: string
  updatedAt: string
  logs?: HabitLog[]
}

export interface HabitLog {
  id: string
  habitId: string
  userId: string
  date: string
  completedCount: number
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface HabitStats {
  totalHabits: number
  totalCompletedToday: number
  completionRate: number
  streaks: {
    longest: Array<{ habitId: string; habitName: string; streakDays: number }>
    current: Array<{ habitId: string; habitName: string; currentStreak: number }>
  }
  dailyProgress: Array<{
    date: string
    totalHabits: number
    completedHabits: number
    completionRate: number
  }>
  habitDetails: Array<{
    habitId: string
    habitName: string
    completionRate: number
    currentStreak: number
    longestStreak: number
    totalCompletions: number
  }>
}
