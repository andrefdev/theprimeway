import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { tasksQueries, useUpdateTask, useDeleteTask } from '@/features/tasks/queries'
import { TaskGroup } from '@/features/tasks/components/TaskGroup'
import { ArchivePanel } from '@/features/tasks/components/ArchivePanel'
import { TaskFullDialog, TaskQuickDialog } from '@/features/tasks/components/dialogs'
import { QueryError } from '@/shared/components/QueryError'
import { FilterBar } from '@/shared/components/FilterBar'
import { PlusIcon } from '@/shared/components/Icons'
import { Button } from '@/shared/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/shared/components/ui/select'
import { DateRangePicker } from '@/shared/components/ui/date-range-picker'
import { usePersistentDateRange } from '@/shared/hooks/use-persistent-date-range'
import { usePersistentAutoArchiveSettings } from '@/shared/hooks/use-auto-archive-settings'
import { SectionHeader } from '@/shared/components/SectionHeader'
import { TasksNav } from '@/features/tasks/components/TasksNav'
import { SkeletonList } from '@/shared/components/ui/skeleton-list'
import { EmptyState } from '@/shared/components/ui/empty-state'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/shared/components/ui/tabs'
import { RecurringManager } from '@/features/recurring/components/RecurringManager'
import { toast } from 'sonner'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useCompletionImpact } from '@/features/tasks/hooks/use-completion-impact'
import type { Task } from '@repo/shared/types'

export const Route = createFileRoute('/_app/tasks/all')({
  component: TasksAllPage,
})

function TasksAllPage() {
  const { t } = useTranslation('tasks')
  // Get today's date in local timezone (not UTC)
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const [dateRange, setDateRange] = usePersistentDateRange('tasks.all.dateRange', 'this_month')
  const [autoArchiveSettings, autoArchiveActions] = usePersistentAutoArchiveSettings()
  const groupedQuery = useQuery(
    tasksQueries.grouped({
      referenceDate: today,
      startDate: dateRange.start ?? undefined,
      endDate: dateRange.end ?? undefined,
      autoArchive: autoArchiveSettings.enabled,
      autoArchiveDays: autoArchiveSettings.days,
    }),
  )
  const updateTask = useUpdateTask()
  const deleteTask = useDeleteTask()
  const showImpact = useCompletionImpact()

  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [showArchive, setShowArchive] = useState(false)

  const STATUS_OPTIONS = [
    { value: 'all', label: t('allStatuses') },
    { value: 'open', label: t('open', { ns: 'common' }) },
    { value: 'completed', label: t('completed', { ns: 'common' }) },
  ]

  const groups = groupedQuery.data?.groups ?? []
  const archive = groupedQuery.data?.archive ?? []

  // Apply client-side filters
  const filteredGroups = useMemo(() => {
    return groups
      .map((g) => ({
        ...g,
        tasks: g.tasks.filter((task: Task) => {
          if (statusFilter !== 'all' && task.status !== statusFilter) return false
          if (search && !task.title.toLowerCase().includes(search.toLowerCase())) return false
          return true
        }),
      }))
      .filter((g) => g.tasks.length > 0)
  }, [groups, statusFilter, search])

  const totalCount = filteredGroups.reduce((sum, g) => sum + g.tasks.length, 0)

  function openCreate() {
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
      await updateTask.mutateAsync({ id: task.id, data: { archivedAt: new Date().toISOString() } })
      toast.success(t('taskArchived', { defaultValue: 'Task archived' }))
    } catch {
      toast.error(t('failedToUpdate'))
    }
  }

  async function handleReschedule(task: Task, date: string) {
    try {
      await updateTask.mutateAsync({
        id: task.id,
        data: { scheduledDate: date, status: 'open', archivedAt: null },
      })
      toast.success(t('taskRescheduled'))
    } catch {
      toast.error(t('failedToUpdate'))
    }
  }

  async function handleDeleteAllArchived() {
    if (archive.length === 0) return
    try {
      await Promise.all(archive.map((t) => deleteTask.mutateAsync(t.id)))
      toast.success(t('archiveCleared', { defaultValue: 'Archive cleared' }))
    } catch {
      toast.error(t('failedToDelete'))
    }
  }

  return (
    <div>
      <TasksNav />
      <SectionHeader
        sectionId="tasks"
        title={t('titleAll')}
        description={`${totalCount} ${t('total')}`}
        actions={
          <div className="flex items-center gap-2">
            {archive.length > 0 && (
              <Button variant="outline" onClick={() => setShowArchive((v) => !v)}>
                {showArchive ? t('hideArchived') : t('showArchived')} ({archive.length})
              </Button>
            )}
            <Button onClick={openCreate}>
              <PlusIcon /> {t('addTask')}
            </Button>
          </div>
        }
      />
      <div className="mx-auto max-w-5xl px-6 pb-6 space-y-6">
        <Tabs defaultValue="tasks" className="w-full">
          <TabsList>
            <TabsTrigger value="tasks">{t('tabAll', { defaultValue: 'Tasks' })}</TabsTrigger>
            <TabsTrigger value="recurring">{t('recurring')}</TabsTrigger>
          </TabsList>

          <TabsContent value="tasks" className="space-y-6 pt-4">
            <FilterBar search={search} onSearchChange={setSearch} searchPlaceholder={t('searchPlaceholder')}>
              <DateRangePicker value={dateRange} onChange={setDateRange} />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="max-w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterBar>

            {groupedQuery.isLoading && <SkeletonList lines={8} />}
            {groupedQuery.isError && <QueryError message={t('failedToLoad')} onRetry={() => groupedQuery.refetch()} />}

            {!groupedQuery.isLoading && !groupedQuery.isError && (
              <div className={showArchive && archive.length > 0 ? 'grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6' : 'grid grid-cols-1 gap-6'}>
                <div className="space-y-3">
                  {filteredGroups.length > 0 ? (
                    filteredGroups.map((group) => (
                      <TaskGroup
                        key={group.date_key}
                        dateKey={group.date_key}
                        tasks={group.tasks}
                        onToggle={toggleTask}
                        onEdit={openEdit}
                        onDelete={handleDelete}
                        onArchive={handleArchive}
                      />
                    ))
                  ) : (
                    <EmptyState
                      title={search || statusFilter !== 'all' ? t('noMatchingTasks') : t('noTasks')}
                      description={search || statusFilter !== 'all' ? t('tryFilters') : t('createFromToday')}
                    />
                  )}
                </div>

                {showArchive && archive.length > 0 && (
                  <div>
                    <ArchivePanel
                      tasks={archive}
                      autoArchive={autoArchiveSettings.enabled}
                      onAutoArchiveChange={autoArchiveActions.setEnabled}
                      rolloverDays={autoArchiveSettings.days}
                      onRolloverDaysChange={autoArchiveActions.setDays}
                      onReschedule={handleReschedule}
                      onDelete={handleDelete}
                      onDeleteAll={handleDeleteAllArchived}
                    />
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="recurring" className="space-y-6 pt-4">
            <RecurringManager />
          </TabsContent>
        </Tabs>
      </div>

      <TaskFullDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingTask(null) }}
        task={editingTask}
      />
      <TaskQuickDialog
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
      />
    </div>
  )
}
