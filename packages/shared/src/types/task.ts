export type TaskStatus = 'open' | 'completed' | 'archived'
export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskBucket =
  | 'TODAY'
  | 'TOMORROW'
  | 'NEXT_WEEK'
  | 'NEXT_MONTH'
  | 'NEXT_QUARTER'
  | 'NEXT_YEAR'
  | 'SOMEDAY'
  | 'NEVER'

export interface Task {
  id: string
  userId: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  dueDate: string | null
  scheduledDate: string | null
  scheduledStart: string | null
  scheduledEnd: string | null
  scheduledBucket: TaskBucket | null
  channelId: string | null
  estimatedDuration: number | null
  plannedTimeMinutes?: number | null
  acceptanceCriteria?: string | null
  completedAt: string | null
  isArchived: boolean
  tags: string[]
  actualStart: string | null
  actualEnd: string | null
  actualDurationSeconds: number | null
  createdAt: string
  updatedAt: string
}

export interface GetTasksParams {
  grouped?: boolean
  date?: string
  status?: 'open' | 'completed'
  priority?: TaskPriority
  search?: string
}

export interface TasksGroupedResponse {
  overdue: Task[]
  today: Task[]
  tomorrow: Task[]
  upcoming: Task[]
  unscheduled: Task[]
}
