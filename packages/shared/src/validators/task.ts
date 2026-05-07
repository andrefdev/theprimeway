import { z } from 'zod'

export const TASK_BUCKETS = [
  'TODAY',
  'TOMORROW',
  'NEXT_WEEK',
  'NEXT_MONTH',
  'NEXT_QUARTER',
  'NEXT_YEAR',
  'SOMEDAY',
  'NEVER',
] as const

export const taskBucketSchema = z.enum(TASK_BUCKETS)

export const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional().default('medium'),
  dueDate: z.string().optional(),
  scheduledDate: z.string().optional(),
  scheduledStart: z.string().optional(),
  scheduledEnd: z.string().optional(),
  scheduledBucket: taskBucketSchema.nullish(),
  isAllDay: z.boolean().optional(),
  estimatedDuration: z.number().optional(),
  acceptanceCriteria: z.string().nullish(),
  tags: z.array(z.string()).optional().default([]),
  weeklyGoalId: z.string().optional(),
  channelId: z.string().nullish(),
  isRecurring: z.boolean().optional(),
  recurrenceRule: z.string().optional(),
  recurrenceEndDate: z.string().optional(),
  autoSchedule: z.boolean().optional(),
  /**
   * Opt out of the default behavior where dated tasks without an explicit time
   * get auto-scheduled into the next free gap. Use for imports, backfills, or
   * any flow that wants the task to remain unscheduled until the user picks a
   * slot.
   */
  skipAutoSchedule: z.boolean().optional(),
})

export const updateTaskSchema = createTaskSchema.partial().extend({
  status: z.enum(['open', 'completed', 'archived']).optional(),
  archivedAt: z.string().nullable().optional(),
  scheduledDate: z.string().nullable().optional(),
  scheduledStart: z.string().nullable().optional(),
  scheduledEnd: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
})

export type CreateTaskInput = z.input<typeof createTaskSchema>
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>
