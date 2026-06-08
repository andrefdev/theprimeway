import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { tasksQueries, useUpdateTask, useDeleteTask } from '@/features/tasks/queries'
import { TaskFullDialog } from '@/features/tasks/components/dialogs'
import { TaskComposer } from '@/features/tasks/components/TaskComposer'
import { TaskItem } from '@/shared/components/TaskItem'
import { QueryError } from '@/shared/components/QueryError'
import { FilterBar } from '@/shared/components/FilterBar'
import { SectionHeader } from '@/shared/components/SectionHeader'
import { TasksNav } from '@/features/tasks/components/TasksNav'
import { SkeletonList } from '@/shared/components/ui/skeleton-list'
import { EmptyState } from '@/shared/components/ui/empty-state'
import { ChevronRightIcon } from '@/shared/components/Icons'
import { toast } from 'sonner'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useCompletionImpact } from '@/features/tasks/hooks/use-completion-impact'
import type { Task, TaskBucket } from '@repo/shared/types'

export const Route = createFileRoute('/_app/tasks/backlog')({
  component: TasksBacklogPage,
})

const BACKLOG_SECTIONS: Array<{ key: TaskBucket; labelKey: string; fallback: string }> = [
  { key: 'NEXT_WEEK', labelKey: 'composer.nextWeek', fallback: 'Next week' },
  { key: 'NEXT_MONTH', labelKey: 'composer.nextMonth', fallback: 'Next month' },
  { key: 'NEXT_QUARTER', labelKey: 'composer.nextQuarter', fallback: 'Next quarter' },
  { key: 'NEXT_YEAR', labelKey: 'composer.nextYear', fallback: 'Next year' },
  { key: 'SOMEDAY', labelKey: 'composer.someday', fallback: 'Someday' },
  { key: 'NEVER', labelKey: 'composer.never', fallback: 'Never' },
]

function TasksBacklogPage() {
  const { t } = useTranslation('tasks')
  const backlogQuery = useQuery(tasksQueries.list({ filter: 'backlog' }))
  const updateTask = useUpdateTask()
  const deleteTask = useDeleteTask()
  const showImpact = useCompletionImpact()

  const [search, setSearch] = useState('')
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const tasks: Task[] = backlogQuery.data?.data ?? []

  const filtered = useMemo(() => {
    if (!search) return tasks
    return tasks.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()))
  }, [tasks, search])

  const sectionMap = useMemo(() => {
    const map = new Map<string, Task[]>()
    map.set('UNSORTED', [])
    for (const s of BACKLOG_SECTIONS) map.set(s.key, [])
    for (const task of filtered) {
      const b = (task.scheduledBucket ?? 'UNSORTED') as string
      const list = map.get(b) ?? map.get('UNSORTED')!
      list.push(task)
    }
    return map
  }, [filtered])

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

  const sectionsToRender = [
    ...BACKLOG_SECTIONS.map((s) => ({ ...s, tasks: sectionMap.get(s.key) ?? [] })),
    {
      key: 'UNSORTED' as const,
      labelKey: 'composer.unsorted',
      fallback: 'Unsorted',
      tasks: sectionMap.get('UNSORTED') ?? [],
    },
  ]

  return (
    <div>
      <TasksNav />
      <SectionHeader
        sectionId="tasks"
        title={t('titleBacklog', { defaultValue: 'Backlog' })}
        description={t('backlogDescription', { defaultValue: '{{count}} unscheduled tasks', count: filtered.length })}
      />
      <div className="mx-auto max-w-5xl px-6 pb-6 space-y-4">
        <TaskComposer defaultBucket="NEXT_WEEK" onCreated={() => backlogQuery.refetch()} />

        <FilterBar search={search} onSearchChange={setSearch} searchPlaceholder={t('searchPlaceholder')} />

        {backlogQuery.isLoading && <SkeletonList lines={6} />}
        {backlogQuery.isError && <QueryError message={t('failedToLoad')} onRetry={() => backlogQuery.refetch()} />}

        {!backlogQuery.isLoading && !backlogQuery.isError && (
          <>
            {filtered.length === 0 ? (
              <EmptyState
                title={t('noBacklogTasks', { defaultValue: 'Backlog is empty' })}
                description={t('noBacklogDescription', { defaultValue: 'All tasks have been scheduled. Nice!' })}
              />
            ) : (
              <div className="space-y-4">
                {sectionsToRender.map((section) => {
                  if (section.tasks.length === 0) return null
                  const isCollapsed = collapsed[section.key]
                  return (
                    <div key={section.key} className="space-y-2">
                      <button
                        type="button"
                        onClick={() => setCollapsed((c) => ({ ...c, [section.key]: !c[section.key] }))}
                        className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
                      >
                        <ChevronRightIcon
                          size={14}
                          className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                        />
                        {t(section.labelKey, { defaultValue: section.fallback })}
                        <span className="text-xs text-muted-foreground/70">({section.tasks.length})</span>
                      </button>
                      {!isCollapsed && (
                        <div className="space-y-1 pl-4">
                          {section.tasks.map((task) => (
                            <TaskItem
                              key={task.id}
                              task={task}
                              onToggle={() => toggleTask(task)}
                              onEdit={() => setEditingTask(task)}
                              onDelete={() => handleDelete(task)}
                              onArchive={() => handleArchive(task)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      <TaskFullDialog
        open={!!editingTask}
        onClose={() => setEditingTask(null)}
        task={editingTask}
      />
    </div>
  )
}
