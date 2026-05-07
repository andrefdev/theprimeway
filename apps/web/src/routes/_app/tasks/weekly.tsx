import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { tasksQueries, useUpdateTask, useDeleteTask } from '@/features/tasks/queries'
import { useAutoSchedule } from '@/features/scheduling/queries'
import { toastSchedulingResult } from '@/features/scheduling/lib/scheduling-toasts'
import { WeekPlanner } from '@/features/tasks/components/WeekPlanner'
import { TaskFullDialog, TaskQuickDialog } from '@/features/tasks/components/dialogs'
import { QueryError } from '@/shared/components/QueryError'
import { Button } from '@/shared/components/ui/button'
import { SectionHeader } from '@/shared/components/SectionHeader'
import { TasksNav } from '@/features/tasks/components/TasksNav'
import { SkeletonList } from '@/shared/components/ui/skeleton-list'
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from '@/shared/components/Icons'
import { toast } from 'sonner'
import { format, addWeeks, addDays, startOfWeek } from 'date-fns'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocale } from '@/i18n/useLocale'
import { useCompletionImpact } from '@/features/tasks/hooks/use-completion-impact'
import type { Task } from '@repo/shared/types'

export const Route = createFileRoute('/_app/tasks/weekly')({
  component: TasksWeeklyPage,
})

function TasksWeeklyPage() {
  const { t } = useTranslation('tasks')
  const { dateFnsLocale } = useLocale()
  const [weekOffset, setWeekOffset] = useState(0)

  const weekStart = useMemo(() => {
    const today = new Date()
    const base = weekOffset === 0 ? today : addWeeks(today, weekOffset)
    return startOfWeek(base, { weekStartsOn: 1 })
  }, [weekOffset])

  const weekStartStr = format(weekStart, 'yyyy-MM-dd')
  const weekEndStr = format(addDays(weekStart, 6), 'yyyy-MM-dd')
  const tasksQuery = useQuery(
    tasksQueries.list({
      filter: 'week',
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      limit: '200',
    }),
  )
  const updateTask = useUpdateTask()
  const deleteTask = useDeleteTask()
  const autoSchedule = useAutoSchedule()
  const showImpact = useCompletionImpact()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [defaultDate, setDefaultDate] = useState<string | undefined>()

  const tasks = tasksQuery.data?.data ?? []

  function openCreate(date?: string) {
    setDefaultDate(date)
    setQuickOpen(true)
  }

  function openEdit(task: Task) {
    setEditingTask(task)
    setDialogOpen(true)
  }

  async function toggleTask(task: Task) {
    const newStatus = task.status === 'completed' ? 'open' : 'completed'
    try {
      await updateTask.mutateAsync({ id: task.id, data: { status: newStatus } })
      if (newStatus === 'completed') {
        showImpact(task.id)
      } else {
        toast.success(t('taskReopened'))
      }
    } catch {
      toast.error(t('failedToUpdate'))
    }
  }

  async function handleDelete(task: Task) {
    try {
      await deleteTask.mutateAsync(task.id)
      toast.success(t('taskDeleted'))
    } catch {
      toast.error(t('failedToDelete'))
    }
  }

  async function handleArchive(task: Task) {
    try {
      await updateTask.mutateAsync({ id: task.id, data: { status: 'archived' } })
      toast.success(t('taskArchived', { defaultValue: 'Task archived' }))
    } catch {
      toast.error(t('failedToUpdate'))
    }
  }

  async function handleMoveToDay(taskId: string, newDate: string) {
    try {
      const result = await autoSchedule.mutateAsync({ taskId, day: newDate })
      toastSchedulingResult(result, t('taskMoved'))
    } catch {
      toast.error(t('failedToUpdate'))
    }
  }

  const weekEnd = addDays(weekStart, 6)
  const weekLabel = `${format(weekStart, 'MMM d', { locale: dateFnsLocale })} - ${format(weekEnd, 'MMM d, yyyy', { locale: dateFnsLocale })}`

  return (
    <div>
      <TasksNav />
      <SectionHeader
        sectionId="tasks"
        title={t('thisWeek')}
        description={weekLabel}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon-sm" onClick={() => setWeekOffset((v) => v - 1)}>
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setWeekOffset(0)}
              disabled={weekOffset === 0}
            >
              {t('todayBadge')}
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => setWeekOffset((v) => v + 1)}>
              <ChevronRightIcon />
            </Button>
            <Button onClick={() => openCreate()}>
              <PlusIcon /> {t('addTask')}
            </Button>
          </div>
        }
      />
      <div className="mx-auto w-full px-6 pb-6 space-y-6">
        {tasksQuery.isLoading && <SkeletonList lines={7} />}
        {tasksQuery.isError && <QueryError message={t('failedToLoad')} onRetry={() => tasksQuery.refetch()} />}

        {!tasksQuery.isLoading && !tasksQuery.isError && (
          <WeekPlanner
            tasks={tasks}
            weekStart={weekStart}
            onToggle={toggleTask}
            onEdit={openEdit}
            onDelete={handleDelete}
            onArchive={handleArchive}
            onMoveToDay={handleMoveToDay}
            onQuickAdd={(date) => openCreate(date)}
          />
        )}
      </div>

      <TaskFullDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingTask(null); setDefaultDate(undefined) }}
        task={editingTask}
        defaultDate={defaultDate}
      />
      <TaskQuickDialog
        open={quickOpen}
        onClose={() => { setQuickOpen(false); setDefaultDate(undefined) }}
        defaultDate={defaultDate}
      />
    </div>
  )
}
