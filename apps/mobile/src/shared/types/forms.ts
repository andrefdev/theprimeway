/**
 * UI-only form schemas + derived types.
 *
 * These are NOT the API wire format (those live in packages/shared/validators).
 * Mobile forms are intentionally simpler than the backend's create/update DTOs:
 * mobile doesn't expose every field the API accepts (recurring, weeklyGoal,
 * channelId, etc.). Keep these schemas focused on what the user actually fills
 * in the FormSheets.
 */
import { z } from 'zod/v4';

// ============================================================
// TASKS
// ============================================================

export const taskFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be 200 characters or less'),
  description: z.string().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  dueDate: z.string().optional(),
  estimatedDurationMinutes: z.number().int().min(1).max(1440).optional(),
  tags: z.array(z.string()).default([]),
  scheduledDate: z.string().optional(),
  scheduledStart: z.string().optional(),
  scheduledEnd: z.string().optional(),
  isAllDay: z.boolean().default(false),
});

export type TaskFormData = z.infer<typeof taskFormSchema>;

// ============================================================
// HABITS
// ============================================================

export const habitFormSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  category: z.string().optional(),
  color: z.string().optional(),
  targetFrequency: z.number().int().min(1).default(1),
  frequencyType: z
    .enum(['daily', 'week_days', 'times_per_week'])
    .default('daily'),
  weekDays: z.array(z.number().int().min(0).max(6)).optional(),
});

export type HabitFormData = z.infer<typeof habitFormSchema>;
