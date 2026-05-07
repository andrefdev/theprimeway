// Form schema lives in @shared/types/forms (UI-only, mobile-specific shape).
// Re-export so consumers can keep importing from @features/habits.
export { habitFormSchema, type HabitFormData } from '@shared/types/forms';

export interface HabitWithLogs {
  id: string;
  name: string;
  description?: string;
  category?: string;
  color: string;
  targetFrequency: number;
  frequencyType?: string;
  weekDays?: number[];
  isActive: boolean;
  createdAt: string;
  logs?: {
    id: string;
    habitId: string;
    date: string;
    completedCount: number;
    notes?: string;
  }[];
}

// Sourced from @repo/shared (single source of truth — matches backend response).
export type { HabitStats } from '@repo/shared/types';

export interface HabitLogPayload {
  date: string;
  completed_count: number;
  notes?: string;
}

export interface CreateHabitPayload {
  name: string;
  description?: string;
  category?: string;
  color?: string;
  target_frequency: number;
  frequency_type: string;
  week_days?: number[];
  is_active?: boolean;
}

export interface UpdateHabitPayload extends Partial<CreateHabitPayload> {}
