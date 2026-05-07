import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { localTimeToUtc, formatInTz } from '@repo/shared/utils'
import { useUserTimezone } from '@/features/settings/hooks/use-user-timezone'
import { tasksQueries, useUpdateTask, useDeleteTask } from '@/features/tasks/queries'
import { TaskFullDialog, TaskQuickDialog } from '@/features/tasks/components/dialogs'
import { QueryError } from '@/shared/components/QueryError'
import { PlusIcon, ChevronLeftIcon, ChevronRightIcon } from '@/shared/components/Icons'
import { Button } from '@/shared/components/ui/button'
import { SectionHeader } from '@/shared/components/SectionHeader'
import { TasksNav } from '@/features/tasks/components/TasksNav'
import { SkeletonList } from '@/shared/components/ui/skeleton-list'
import { EmptyState } from '@/shared/components/ui/empty-state'
import { TaskItem } from '@/shared/components/TaskItem'
import { TimeGrid } from '@/features/calendar/components/calendar-grid/TimeGrid'
import { useCalendarItems, type CalendarItem } from '@/features/calendar/hooks/use-calendar-items'
import {
  useUpsertWorkingHoursOverride,
  useAutoSchedule,
  useMoveSession,
} from '@/features/scheduling/queries'
import { useEffectiveDayBounds } from '@/features/scheduling/hooks/use-effective-day-bounds'
import { useRitualsToday } from '@/features/rituals/queries'
import { DailyPlanDialog } from '@/features/rituals/components/DailyPlanDialog'
import { DailyShutdownDialog } from '@/features/rituals/components/DailyShutdownDialog'
import { WorkloadCounter } from '@/features/scheduling/components/WorkloadCounter'
import { toast } from 'sonner'
import { addDays, format } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { useLocale } from '@/i18n/useLocale'
import { useCompletionImpact } from '@/features/tasks/hooks/use-completion-impact'
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { Task } from '@repo/shared/types'

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtHour(h: number): string {
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function TasksToday() {
  const { t } = useTranslation('tasks')
  const { dateFnsLocale } = useLocale()

  const [day, setDay] = useState<Date>(() => new Date())
  const dayKey = ymd(day)

  const tasksQuery = useQuery(tasksQueries.today(dayKey))
  const updateTask = useUpdateTask()
  const deleteTask = useDeleteTask()
  const showImpact = useCompletionImpact()
  const autoSchedule = useAutoSchedule()
  const moveSession = useMoveSession()
  const dayBounds = useEffectiveDayBounds(dayKey)
  const upsertOverride = useUpsertWorkingHoursOverride()
  const tz = useUserTimezone()

  const { items: calendarItems } = useCalendarItems({ from: dayKey, to: dayKey })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickStart, setQuickStart] = useState<string | undefined>(undefined)
  const [quickEnd, setQuickEnd] = useState<string | undefined>(undefined)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [planDismissed, setPlanDismissed] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [shutdownDismissed, setShutdownDismissed] = useState(false)
  const [shutdownOpen, setShutdownOpen] = useState(false)
  const ritualsQuery = useRitualsToday()
  const pendingDailyPlan = ritualsQuery.data?.pending.find((p) => p.ritual.kind === 'DAILY_PLAN') ?? null
  const pendingShutdown = ritualsQuery.data?.pending.find((p) => p.ritual.kind === 'DAILY_SHUTDOWN') ?? null

  useEffect(() => {
    if (pendingDailyPlan && !planDismissed) setPlanOpen(true)
  }, [pendingDailyPlan, planDismissed])

  useEffect(() => {
    if (!pendingShutdown || shutdownDismissed || planOpen) return
    const now = new Date()
    const scheduled = new Date(pendingShutdown.scheduledFor)
    if (now >= scheduled) setShutdownOpen(true)
  }, [pendingShutdown, shutdownDismissed, planOpen])

  const tasks = tasksQuery.data?.data ?? []
  const openTasks = tasks.filter((task: Task) => task.status === 'open')

  const { scheduled, unscheduled } = useMemo(() => {
    const sched: Task[] = []
    const unsched: Task[] = []
    for (const task of openTasks) {
      if (task.scheduledStart) sched.push(task)
      else unsched.push(task)
    }
    sched.sort(
      (a, b) => new Date(a.scheduledStart!).getTime() - new Date(b.scheduledStart!).getTime(),
    )
    return { scheduled: sched, unscheduled: unsched }
  }, [openTasks])

  function openCreate(start?: Date) {
    if (start) {
      const dayStart = localTimeToUtc(start, fmtHour(dayBounds.startHour), tz)
      const dayEnd = localTimeToUtc(start, fmtHour(dayBounds.endHour), tz)
      const DURATION_MS = 30 * 60_000
      let clamped = start
      if (start.getTime() < dayStart.getTime()) {
        clamped = dayStart
      } else if (start.getTime() + DURATION_MS > dayEnd.getTime()) {
        clamped = new Date(Math.max(dayStart.getTime(), dayEnd.getTime() - DURATION_MS))
      }
      setQuickStart(clamped.toISOString())
      setQuickEnd(new Date(clamped.getTime() + DURATION_MS).toISOString())
    } else {
      setQuickStart(undefined)
      setQuickEnd(undefined)
    }
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
      if (newStatus === 'completed') showImpact(task.id)
      else toast.success(t('taskReopened'))
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

  async function planDay() {
    if (unscheduled.length === 0) return
    let ok = 0
    const failures: Record<'NO_WORKING_HOURS' | 'NO_GAPS' | 'WOULD_NOT_FIT' | 'UNKNOWN', number> = {
      NO_WORKING_HOURS: 0,
      NO_GAPS: 0,
      WOULD_NOT_FIT: 0,
      UNKNOWN: 0,
    }
    for (const task of unscheduled) {
      try {
        const r = await autoSchedule.mutateAsync({ taskId: task.id, day: dayKey })
        if (r.type === 'Success') ok++
        else failures[r.reason] = (failures[r.reason] ?? 0) + 1
      } catch {
        failures.UNKNOWN++
      }
    }
    if (ok > 0) toast.success(`Scheduled ${ok} task${ok === 1 ? '' : 's'}`)
    if (failures.NO_WORKING_HOURS > 0) {
      toast.warning(
        `${failures.NO_WORKING_HOURS} task${failures.NO_WORKING_HOURS === 1 ? '' : 's'} skipped — no working hours set for this day`,
      )
    }
    if (failures.NO_GAPS > 0) {
      toast.warning(
        `${failures.NO_GAPS} task${failures.NO_GAPS === 1 ? '' : 's'} skipped — your day is already full`,
      )
    }
    if (failures.WOULD_NOT_FIT > 0) {
      toast.warning(
        `${failures.WOULD_NOT_FIT} task${failures.WOULD_NOT_FIT === 1 ? '' : 's'} too long for any free gap — try splitting or rescheduling`,
      )
    }
    if (failures.UNKNOWN > 0) {
      toast.error(`${failures.UNKNOWN} task${failures.UNKNOWN === 1 ? '' : 's'} failed to schedule`)
    }
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  async function placeTaskAt(taskId: string, start: Date, end: Date) {
    // Prefer moving an existing WorkingSession over creating a new one so split
    // sessions don't accumulate. The first session for the task on the visible
    // day wins; multi-session splits would need a richer drag UX.
    const existing = calendarItems.find(
      (i) => i.type === 'session' && i.task?.id === taskId,
    )
    try {
      await moveSession.mutateAsync({
        sessionId: existing?.sessionId,
        taskId: existing?.sessionId ? undefined : taskId,
        start: start.toISOString(),
        end: end.toISOString(),
      })
    } catch {
      toast.error(t('failedToUpdate'))
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const taskId = String(active.id)
    const task = openTasks.find((x) => x.id === taskId)
    if (!task) return

    const overData = (over.data.current ?? {}) as { start?: string; type?: string; taskId?: string }

    // Case 1: dropped on a calendar slot
    if (overData.start) {
      const start = new Date(overData.start)
      const duration = task.estimatedDuration ?? 30
      const end = new Date(start.getTime() + duration * 60_000)
      await placeTaskAt(taskId, start, end)
      return
    }

    // Case 2: dropped on another task in the list — reschedule dragged right after
    // the target. If target is unscheduled, just put dragged at start of working day.
    if (overData.type === 'task' && overData.taskId) {
      if (overData.taskId === taskId) return
      const target = openTasks.find((x) => x.id === overData.taskId)
      if (!target) return
      const duration = task.estimatedDuration ?? 30
      // Anchor the target's time-of-day (in user TZ) onto the visible day so
      // reorder never crosses days, even if the target's session is split or
      // its mirror is stale.
      const anchorTimeOnDay = (utcInstant: Date): Date =>
        localTimeToUtc(day, formatInTz(utcInstant, tz, 'HH:mm'), tz)
      const DURATION_MS = duration * 60_000
      const dayStartUtc = localTimeToUtc(day, fmtHour(dayBounds.startHour), tz)
      const dayEndUtc = localTimeToUtc(day, fmtHour(dayBounds.endHour), tz)
      let start: Date
      if (target.scheduledEnd) {
        start = anchorTimeOnDay(new Date(target.scheduledEnd))
      } else if (target.scheduledStart) {
        const targetDur = target.estimatedDuration ?? 30
        const computed = new Date(
          new Date(target.scheduledStart).getTime() + targetDur * 60_000,
        )
        start = anchorTimeOnDay(computed)
      } else {
        start = dayStartUtc
      }
      if (start.getTime() < dayStartUtc.getTime()) {
        start = dayStartUtc
      } else if (start.getTime() + DURATION_MS > dayEndUtc.getTime()) {
        start = new Date(
          Math.max(dayStartUtc.getTime(), dayEndUtc.getTime() - DURATION_MS),
        )
      }
      const end = new Date(start.getTime() + DURATION_MS)
      await placeTaskAt(taskId, start, end)
    }
  }

  function handleDayBoundsChange(next: { startHour: number; endHour: number }) {
    upsertOverride.mutate({
      date: dayKey,
      startTime: fmtHour(next.startHour),
      endTime: fmtHour(next.endHour),
    })
  }

  return (
    <div>
      <TasksNav />
      <SectionHeader
        sectionId="tasks"
        title={format(day, 'EEEE, MMMM d', { locale: dateFnsLocale })}
        description={`${openTasks.length} ${t('open', { ns: 'common' })}`}
        actions={
          <div className="flex items-center gap-2">
            <WorkloadCounter day={dayKey} tasks={tasks} />
            {unscheduled.length > 0 && (
              <Button variant="outline" disabled={autoSchedule.isPending} onClick={planDay}>
                {autoSchedule.isPending ? 'Planning…' : `Plan day (${unscheduled.length})`}
              </Button>
            )}
            <Button onClick={() => openCreate()}>
              <PlusIcon /> {t('addTask')}
            </Button>
          </div>
        }
      />

      <div className="px-6 pb-6">
        {tasksQuery.isLoading && <SkeletonList lines={8} />}
        {tasksQuery.isError && <QueryError message={t('failedToLoad')} onRetry={() => tasksQuery.refetch()} />}

        {!tasksQuery.isLoading && !tasksQuery.isError && (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <div className="flex flex-col gap-4 lg:flex-row lg:gap-6">
              {/* Left pane — task list */}
              <div className="lg:w-[420px] flex-shrink-0 space-y-2">
                <button
                  type="button"
                  onClick={() => openCreate()}
                  className="w-full text-left rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:border-primary hover:text-foreground transition-colors"
                >
                  + {t('addTask')}
                </button>

                {scheduled.map((task) => (
                  <DraggableTask
                    key={task.id}
                    task={task}
                    onToggle={() => toggleTask(task)}
                    onEdit={() => openEdit(task)}
                    onDelete={() => handleDelete(task)}
                    onArchive={() => handleArchive(task)}
                  />
                ))}

                {unscheduled.length > 0 && (
                  <p className="pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t('unscheduled', { defaultValue: 'Unscheduled' })}
                  </p>
                )}
                {unscheduled.map((task) => (
                  <DraggableTask
                    key={task.id}
                    task={task}
                    onToggle={() => toggleTask(task)}
                    onEdit={() => openEdit(task)}
                    onDelete={() => handleDelete(task)}
                    onArchive={() => handleArchive(task)}
                  />
                ))}

                {tasks.length === 0 && (
                  <EmptyState title={t('allDone')} description={t('noOpenTasks')} />
                )}
              </div>

              {/* Right pane — calendar */}
              <div className="flex-1 min-w-0 rounded-md border border-border overflow-hidden flex flex-col h-[calc(100vh-220px)]">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDay((d) => addDays(d, -1))}>
                      <ChevronLeftIcon />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDay((d) => addDays(d, 1))}>
                      <ChevronRightIcon />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDay(new Date())}>
                      {t('today', { ns: 'calendar', defaultValue: 'Today' })}
                    </Button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {fmtHour(dayBounds.startHour)} – {fmtHour(dayBounds.endHour)}
                  </span>
                </div>
                <div className="flex-1 min-h-0">
                  <TimeGrid
                    days={[day]}
                    items={calendarItems}
                    today={new Date()}
                    onSlotClick={(start) => openCreate(start)}
                    onItemClick={(item: CalendarItem) => {
                      if ((item.type === 'task' || item.type === 'session') && item.task) {
                        openEdit(item.task)
                      }
                    }}
                    enableSlotDrop
                    dayStartHour={dayBounds.startHour}
                    dayEndHour={dayBounds.endHour}
                    onDayBoundsChange={handleDayBoundsChange}
                  />
                </div>
              </div>
            </div>
          </DndContext>
        )}
      </div>

      <TaskFullDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingTask(null) }}
        task={editingTask}
        defaultDate={dayKey}
      />
      <TaskQuickDialog
        open={quickOpen}
        onClose={() => { setQuickOpen(false); setQuickStart(undefined); setQuickEnd(undefined) }}
        defaultDate={dayKey}
        defaultBucket="TODAY"
        defaultStart={quickStart}
        defaultEnd={quickEnd}
        autoSchedule={!quickStart}
      />

      {pendingDailyPlan && (
        <DailyPlanDialog
          instance={pendingDailyPlan}
          open={planOpen}
          onClose={() => { setPlanOpen(false); setPlanDismissed(true) }}
        />
      )}

      {pendingShutdown && (
        <DailyShutdownDialog
          instance={pendingShutdown}
          open={shutdownOpen}
          onClose={() => { setShutdownOpen(false); setShutdownDismissed(true) }}
        />
      )}
    </div>
  )
}

function DraggableTask({
  task,
  onToggle,
  onEdit,
  onDelete,
  onArchive,
}: {
  task: Task
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onArchive: () => void
}) {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({ id: task.id })
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${task.id}`,
    data: { type: 'task', taskId: task.id },
  })
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
  }
  const handle = (
    <button
      type="button"
      ref={setDragRef}
      {...listeners}
      {...attributes}
      className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
      aria-label="Drag"
    >
      ⋮⋮
    </button>
  )
  return (
    <div
      ref={setDropRef}
      style={style}
      className={isOver ? 'rounded-md ring-2 ring-primary/60' : undefined}
    >
      <TaskItem
        task={task}
        onToggle={onToggle}
        onEdit={onEdit}
        onDelete={onDelete}
        onArchive={onArchive}
        dragHandle={handle}
      />
    </div>
  )
}
