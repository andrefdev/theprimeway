import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { localTimeToUtc, formatInTz } from '@repo/shared/utils'
import { useUserTimezone } from '@/features/settings/hooks/use-user-timezone'
import {
  emptyFailureCounts,
  classifyResult,
  toastSchedulingBatch,
  toastSchedulingResult,
} from '@/features/scheduling/lib/scheduling-toasts'
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
  usePlaceTask,
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
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
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
  const placeTask = usePlaceTask()
  const dayBounds = useEffectiveDayBounds(dayKey)
  const upsertOverride = useUpsertWorkingHoursOverride()
  const tz = useUserTimezone()

  const { items: calendarItems } = useCalendarItems({ from: dayKey, to: dayKey })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickStart, setQuickStart] = useState<string | undefined>(undefined)
  const [quickEnd, setQuickEnd] = useState<string | undefined>(undefined)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [activeDragTask, setActiveDragTask] = useState<Task | null>(null)
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

  // Membership ("is this task scheduled today?") is derived from sessions, not
  // from the Task.scheduledStart mirror — that mirror can lag the source of
  // truth right after a drag/move and produced the cross-view drift.
  const sessionStartsByTaskId = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of calendarItems) {
      if (item.type !== 'session' || !item.task?.id) continue
      const ts = item.start.getTime()
      const prev = map.get(item.task.id)
      if (prev === undefined || ts < prev) map.set(item.task.id, ts)
    }
    return map
  }, [calendarItems])

  const { scheduled, unscheduled } = useMemo(() => {
    const sched: Task[] = []
    const unsched: Task[] = []
    for (const task of openTasks) {
      if (sessionStartsByTaskId.has(task.id)) sched.push(task)
      else unsched.push(task)
    }
    sched.sort(
      (a, b) =>
        (sessionStartsByTaskId.get(a.id) ?? 0) - (sessionStartsByTaskId.get(b.id) ?? 0),
    )
    return { scheduled: sched, unscheduled: unsched }
  }, [openTasks, sessionStartsByTaskId])

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
      await updateTask.mutateAsync({ id: task.id, data: { archivedAt: new Date().toISOString() } })
      toast.success(t('taskArchived', { defaultValue: 'Task archived' }))
    } catch {
      toast.error(t('failedToUpdate'))
    }
  }

  async function planDay() {
    if (unscheduled.length === 0) return
    let ok = 0
    const failures = emptyFailureCounts()
    for (const task of unscheduled) {
      try {
        const r = await autoSchedule.mutateAsync({ taskId: task.id, day: dayKey })
        if (classifyResult(r, failures)) ok++
      } catch {
        failures.UNKNOWN++
      }
    }
    toastSchedulingBatch(ok, failures)
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  async function placeTaskAt(taskId: string, start: Date, end: Date) {
    // Prefer moving an existing WorkingSession over creating a new one so split
    // sessions don't accumulate. The first session for the task on the visible
    // day wins; multi-session splits would need a richer drag UX.
    const existing = calendarItems.find(
      (i) => i.type === 'session' && i.task?.id === taskId,
    )
    // Skip optimistic placeholder ids (`temp-…`) — they only live in the
    // client cache while the prior createSession is in flight. Sending them
    // back as `sessionId` produces a 404 server-side. Treat them like
    // "no existing session" so we hit the create-from-task path, which
    // will replace the placeholder atomically on success.
    const realSessionId =
      existing?.sessionId && !existing.sessionId.startsWith('temp-')
        ? existing.sessionId
        : undefined
    try {
      await moveSession.mutateAsync({
        sessionId: realSessionId,
        taskId: realSessionId ? undefined : taskId,
        start: start.toISOString(),
        end: end.toISOString(),
      })
    } catch {
      toast.error(t('failedToUpdate'))
    }
  }

  async function handleItemResize(item: CalendarItem, start: Date, end: Date) {
    const realSessionId =
      item.sessionId && !item.sessionId.startsWith('temp-') ? item.sessionId : undefined
    try {
      await moveSession.mutateAsync({
        sessionId: realSessionId,
        taskId: realSessionId ? undefined : item.task?.id,
        start: start.toISOString(),
        end: end.toISOString(),
      })
    } catch {
      toast.error(t('failedToUpdate'))
    }
  }

  function handleDragStart(event: DragStartEvent) {
    // Both list items (SortableTask) and calendar session blocks
    // (DraggableEventBlock) carry `data.taskId`; calendar blocks use a
    // `calitem:{id}` drag id so they don't collide with the list's `{id}`.
    const id =
      (event.active.data.current as { taskId?: string } | undefined)?.taskId ??
      String(event.active.id)
    const t = openTasks.find((x) => x.id === id)
    setActiveDragTask(t ?? null)
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDragTask(null)
    const { active, over } = event
    if (!over) return
    const taskId =
      (active.data.current as { taskId?: string } | undefined)?.taskId ??
      String(active.id)
    const task = openTasks.find((x) => x.id === taskId)
    if (!task) return

    const overData = (over.data.current ?? {}) as { start?: string; type?: string; taskId?: string }

    // Case 1: dropped on a calendar slot. Use placeTask (not moveSession) so
    // the server can split the task around any busy block that collides with
    // the requested slot — e.g. dropping a 60-min task at 3:00pm with an
    // event at 3:30–4:00 yields [3:00–3:30] + [4:00–4:30] instead of one
    // overlapping or pushed-aside block.
    if (overData.start) {
      const start = new Date(overData.start)
      const duration = task.estimatedDuration ?? 30
      try {
        const result = await placeTask.mutateAsync({
          taskId,
          preferredStart: start.toISOString(),
          duration,
        })
        toastSchedulingResult(result, t('taskMoved'))
      } catch {
        toast.error(t('failedToUpdate'))
      }
      return
    }

    // Case 2: dropped on another task in the list.
    if (overData.type === 'task' && overData.taskId) {
      if (overData.taskId === taskId) return

      const earliestSessionForTask = (id: string) => {
        let earliest: { sessionId: string; start: Date; end: Date } | null = null
        for (const item of calendarItems) {
          if (item.type !== 'session' || item.task?.id !== id) continue
          if (!earliest || item.start.getTime() < earliest.start.getTime()) {
            earliest = { sessionId: item.sessionId!, start: item.start, end: item.end }
          }
        }
        return earliest
      }

      const draggedSession = earliestSessionForTask(taskId)
      const targetSession = earliestSessionForTask(overData.taskId)

      // SWAP path: both tasks already have a session today → swap their
      // start times in parallel, preserving each task's duration. This kills
      // the "drift forever" feedback loop where each reorder placed the
      // dragged session AFTER target.end — repeating the gesture pushed
      // both tasks 30 min later every cycle, until they fell off the day.
      if (
        draggedSession &&
        targetSession &&
        !draggedSession.sessionId.startsWith('temp-') &&
        !targetSession.sessionId.startsWith('temp-')
      ) {
        const draggedDurationMs =
          draggedSession.end.getTime() - draggedSession.start.getTime()
        const targetDurationMs =
          targetSession.end.getTime() - targetSession.start.getTime()
        const draggedNewStart = targetSession.start
        const targetNewStart = draggedSession.start
        try {
          await Promise.all([
            moveSession.mutateAsync({
              sessionId: draggedSession.sessionId,
              start: draggedNewStart.toISOString(),
              end: new Date(draggedNewStart.getTime() + draggedDurationMs).toISOString(),
            }),
            moveSession.mutateAsync({
              sessionId: targetSession.sessionId,
              start: targetNewStart.toISOString(),
              end: new Date(targetNewStart.getTime() + targetDurationMs).toISOString(),
            }),
          ])
        } catch {
          toast.error(t('failedToUpdate'))
        }
        return
      }

      // Append path: target has a session today but dragged doesn't yet
      // (or has only a temp placeholder mid-flight) → place dragged right
      // after target.end. Same anchoring rule as before so reorder never
      // crosses days for split target sessions.
      if (targetSession) {
        const duration = task.estimatedDuration ?? 30
        const DURATION_MS = duration * 60_000
        const anchorTimeOnDay = (utcInstant: Date): Date =>
          localTimeToUtc(day, formatInTz(utcInstant, tz, 'HH:mm'), tz)
        const dayStartUtc = localTimeToUtc(day, fmtHour(dayBounds.startHour), tz)
        const dayEndUtc = localTimeToUtc(day, fmtHour(dayBounds.endHour), tz)
        let start = anchorTimeOnDay(targetSession.end)
        if (start.getTime() < dayStartUtc.getTime()) {
          start = dayStartUtc
        } else if (start.getTime() + DURATION_MS > dayEndUtc.getTime()) {
          start = new Date(
            Math.max(dayStartUtc.getTime(), dayEndUtc.getTime() - DURATION_MS),
          )
        }
        const end = new Date(start.getTime() + DURATION_MS)
        await placeTaskAt(taskId, start, end)
        return
      }

      // Target without a session today → auto-schedule the dragged task into
      // the next gap. The gap-finder respects "now" when day === today, so a
      // 7 PM drag lands at the next free slot from 7 PM, not 9 AM.
      try {
        const result = await autoSchedule.mutateAsync({ taskId, day: dayKey })
        toastSchedulingResult(result, t('taskMoved'))
      } catch {
        toast.error(t('failedToUpdate'))
      }
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
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveDragTask(null)}
          >
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

                <SortableContext
                  items={[...scheduled, ...unscheduled].map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {scheduled.map((task) => (
                    <SortableTask
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
                    <SortableTask
                      key={task.id}
                      task={task}
                      onToggle={() => toggleTask(task)}
                      onEdit={() => openEdit(task)}
                      onDelete={() => handleDelete(task)}
                      onArchive={() => handleArchive(task)}
                    />
                  ))}
                </SortableContext>

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
                    enableItemDrag
                    onItemResize={handleItemResize}
                    dayStartHour={dayBounds.startHour}
                    dayEndHour={dayBounds.endHour}
                    onDayBoundsChange={handleDayBoundsChange}
                  />
                </div>
              </div>
            </div>
            <DragOverlay dropAnimation={null}>
              {activeDragTask ? (
                <div className="w-[400px] opacity-95 shadow-2xl rounded-md rotate-1 pointer-events-none">
                  <TaskItem
                    task={activeDragTask}
                    onToggle={() => {}}
                    onEdit={() => {}}
                    onDelete={() => {}}
                  />
                </div>
              ) : null}
            </DragOverlay>
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

function SortableTask({
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
  // `data` is read by handleDragEnd Case 2 to detect "drop on another task"
  // and route to the in-list reorder logic. SortableContext fills in the
  // visual reorder feedback (items shift to make room) so the dragged task
  // doesn't visually overlap the target the way the old useDraggable+
  // useDroppable combo did.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', taskId: task.id },
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  const handle = (
    <button
      type="button"
      {...listeners}
      {...attributes}
      className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
      aria-label="Drag"
    >
      ⋮⋮
    </button>
  )
  return (
    <div ref={setNodeRef} style={style}>
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
