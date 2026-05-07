import { useEffect, useRef, useState } from 'react'
import { useForm, type UseFormReturn } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createTaskSchema, type CreateTaskInput } from '@repo/shared/validators'
import type { Task } from '@repo/shared/types'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useCreateTask, useUpdateTask, useEstimateTimebox } from '../queries'
import { useCreateRecurring } from '@/features/recurring/queries'
import type { RecurrencePattern } from '@/features/recurring/api'
import { useScheduleSuggestion } from './use-schedule-suggestion'

export interface RepeatState {
  enabled: boolean
  pattern: RecurrencePattern
  daysOfWeek: number[]
  time: string
  endDate: string
}

export interface UseTaskFormOptions {
  open: boolean
  task?: Task | null
  defaultDate?: string
  defaultStart?: string
  defaultEnd?: string
  defaultBucket?: string | null
  /** Auto-estimate duration from title via AI (only on create). */
  autoEstimate?: boolean
  /** Enable repeat controls (only meaningful on create). */
  enableRepeat?: boolean
  /**
   * Forwards `autoSchedule: true` on create. Mostly redundant now that the
   * server auto-schedules dated tasks by default; kept for explicitness and
   * for the rare caller that wants to flip it off (pass `false`).
   */
  autoSchedule?: boolean
  onSaved?: () => void
}

export interface UseTaskFormReturn {
  form: UseFormReturn<CreateTaskInput>
  isEdit: boolean
  isPending: boolean
  estimating: boolean
  scheduleSuggestion: { start: string; end: string } | undefined
  scheduleSuggestionLoading: boolean
  repeat: RepeatState
  setRepeat: React.Dispatch<React.SetStateAction<RepeatState>>
  markDurationTouched: () => void
  addTag: (tag: string) => void
  removeTag: (tag: string) => void
  submit: (e?: React.FormEvent) => Promise<void>
}

const DEFAULT_REPEAT: RepeatState = {
  enabled: false,
  pattern: 'DAILY',
  daysOfWeek: [1, 2, 3, 4, 5],
  time: '',
  endDate: '',
}

export function useTaskForm({
  open,
  task,
  defaultDate,
  defaultStart,
  defaultEnd,
  defaultBucket,
  autoEstimate = false,
  enableRepeat = false,
  autoSchedule = true,
  onSaved,
}: UseTaskFormOptions): UseTaskFormReturn {
  const { t } = useTranslation('tasks')
  const isEdit = !!task

  const createTask = useCreateTask()
  const updateTask = useUpdateTask()
  const createRecurring = useCreateRecurring()
  const estimateTimebox = useEstimateTimebox()

  const [repeat, setRepeat] = useState<RepeatState>(DEFAULT_REPEAT)

  const form = useForm<CreateTaskInput>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: {
      title: '',
      description: '',
      priority: 'medium',
      scheduledDate: defaultDate,
      estimatedDuration: undefined,
      tags: [],
      weeklyGoalId: undefined,
    },
  })

  const userTouchedDuration = useRef(false)
  const lastEstimatedTitle = useRef('')

  const title = form.watch('title')
  const description = form.watch('description')
  const scheduledDate = form.watch('scheduledDate')
  const estimatedDuration = form.watch('estimatedDuration')

  const { data: scheduleSuggestion, isLoading: scheduleSuggestionLoading } =
    useScheduleSuggestion(scheduledDate, estimatedDuration)

  // Auto-estimate duration as title is typed (debounced).
  useEffect(() => {
    if (!open || isEdit || !autoEstimate) return
    if (userTouchedDuration.current) return
    const trimmed = (title ?? '').trim()
    if (trimmed.length < 3) return
    if (trimmed === lastEstimatedTitle.current) return
    const handle = setTimeout(async () => {
      try {
        const result = await estimateTimebox.mutateAsync({ title: trimmed, description })
        if (!userTouchedDuration.current) {
          lastEstimatedTitle.current = trimmed
          form.setValue('estimatedDuration', result.minutes)
        }
      } catch {
        // ignore
      }
    }, 700)
    return () => clearTimeout(handle)
  }, [title, description, open, isEdit, autoEstimate, estimateTimebox, form])

  // Reset on open / task change.
  useEffect(() => {
    if (!open) return
    userTouchedDuration.current = false
    lastEstimatedTitle.current = ''
    setRepeat(DEFAULT_REPEAT)
    if (task) {
      const hasTimes = !!(task.scheduledStart && task.scheduledEnd)
      form.reset({
        title: task.title,
        description: task.description ?? '',
        priority: task.priority,
        scheduledDate: task.scheduledDate ?? undefined,
        scheduledStart: task.scheduledStart ?? undefined,
        scheduledEnd: task.scheduledEnd ?? undefined,
        scheduledBucket: (task as any).scheduledBucket ?? undefined,
        channelId: (task as any).channelId ?? undefined,
        isAllDay: (task as any).isAllDay ?? !hasTimes,
        estimatedDuration: task.estimatedDuration ?? undefined,
        tags: task.tags ?? [],
        weeklyGoalId: (task as any).weeklyGoalId ?? undefined,
      })
    } else {
      const hasTimes = !!(defaultStart && defaultEnd)
      let inferredDuration: number | undefined
      if (hasTimes) {
        const ms = new Date(defaultEnd!).getTime() - new Date(defaultStart!).getTime()
        if (Number.isFinite(ms) && ms > 0) inferredDuration = Math.round(ms / 60_000)
      }
      form.reset({
        title: '',
        description: '',
        priority: 'medium',
        scheduledDate: defaultDate,
        scheduledStart: defaultStart,
        scheduledEnd: defaultEnd,
        scheduledBucket: (defaultBucket as any) ?? undefined,
        channelId: undefined,
        isAllDay: !hasTimes,
        estimatedDuration: inferredDuration,
        tags: [],
      })
    }
  }, [open, task, defaultDate, defaultStart, defaultEnd, defaultBucket, form])

  const markDurationTouched = () => {
    userTouchedDuration.current = true
  }

  function addTag(tag: string) {
    const trimmed = tag.trim()
    if (!trimmed) return
    const tags = form.getValues('tags') ?? []
    if (tags.includes(trimmed)) return
    form.setValue('tags', [...tags, trimmed])
  }

  function removeTag(tag: string) {
    const tags = form.getValues('tags') ?? []
    form.setValue('tags', tags.filter((x) => x !== tag))
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault()
    await form.handleSubmit(async (data) => {
      try {
        if (
          !data.scheduledStart &&
          !data.scheduledEnd &&
          data.scheduledDate &&
          data.estimatedDuration &&
          scheduleSuggestion
        ) {
          data.scheduledStart = scheduleSuggestion.start
          data.scheduledEnd = scheduleSuggestion.end
          data.isAllDay = false
        }
        if (isEdit && task) {
          // Fire-and-forget: optimistic cache patch already runs in onMutate,
          // so close the modal immediately instead of waiting for the round-trip.
          updateTask.mutate(
            { id: task.id, data },
            { onError: () => toast.error(t('failedToUpdate')) },
          )
          toast.success(t('taskUpdated'))
          onSaved?.()
          return
        } else if (enableRepeat && repeat.enabled) {
          if (repeat.pattern === 'WEEKLY' && repeat.daysOfWeek.length === 0) {
            toast.error(t('selectAtLeastOneDay'))
            return
          }
          const today = new Date()
          const yyyy = today.getFullYear()
          const mm = String(today.getMonth() + 1).padStart(2, '0')
          const dd = String(today.getDate()).padStart(2, '0')
          const startDate = data.scheduledDate || `${yyyy}-${mm}-${dd}`
          await createRecurring.mutateAsync({
            templateTaskJson: data as unknown as Record<string, unknown>,
            pattern: repeat.pattern,
            daysOfWeek: repeat.pattern === 'WEEKLY' ? repeat.daysOfWeek : undefined,
            atRoughlyTime: repeat.time || undefined,
            startDate,
            endDate: repeat.endDate || undefined,
          })
          toast.success(t('seriesCreated'))
        } else {
          const payload = autoSchedule && !data.scheduledStart && !data.isAllDay
            ? { ...data, autoSchedule: true }
            : data
          // Fire-and-forget: optimistic patch already runs in onMutate, so we
          // can close the modal immediately instead of waiting for the round-trip.
          createTask.mutate(payload as typeof data, {
            onError: () => toast.error(t('failedToCreate')),
          })
          toast.success(t('taskCreated'))
          onSaved?.()
          return
        }
        onSaved?.()
      } catch {
        toast.error(
          isEdit
            ? t('failedToUpdate')
            : enableRepeat && repeat.enabled
              ? t('failedToCreateSeries')
              : t('failedToCreate'),
        )
      }
    })()
  }

  const isPending =
    createTask.isPending || updateTask.isPending || createRecurring.isPending

  return {
    form,
    isEdit,
    isPending,
    estimating: estimateTimebox.isPending,
    scheduleSuggestion: scheduleSuggestion ?? undefined,
    scheduleSuggestionLoading,
    repeat,
    setRepeat,
    markDurationTouched,
    addTag,
    removeTag,
    submit,
  }
}
