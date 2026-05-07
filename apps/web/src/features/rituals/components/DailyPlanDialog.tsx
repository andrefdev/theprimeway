import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { tasksQueries, useCreateTask } from '@/features/tasks/queries'
import { schedulingApi } from '@/features/scheduling/api'
import { schedulingKeys } from '@/features/scheduling/queries'
import { useAddReflection, useUpdateRitualInstance } from '../queries'
import type { RitualInstance } from '../api'
import type { Task } from '@repo/shared/types'

interface Props {
  instance: RitualInstance
  open: boolean
  onClose: () => void
}

type Step = 'highlight' | 'confirm' | 'plan' | 'done'

export function DailyPlanDialog({ instance, open, onClose }: Props) {
  const { t } = useTranslation('rituals')
  const [step, setStep] = useState<Step>('highlight')
  const [highlight, setHighlight] = useState('')
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [planning, setPlanning] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const createTask = useCreateTask()

  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const tasksQuery = useQuery(tasksQueries.today(today))
  const openTasks = useMemo(
    () => ((tasksQuery.data?.data ?? []) as Task[]).filter((t) => t.status === 'open'),
    [tasksQuery.data],
  )

  const qc = useQueryClient()
  const updateInstance = useUpdateRitualInstance()
  const addReflection = useAddReflection()

  useEffect(() => {
    // Default: all open tasks selected
    setSelectedTaskIds(new Set(openTasks.map((t) => t.id)))
  }, [openTasks])

async function saveHighlightAndAdvance() {
    if (highlight.trim()) {
      try {
        await addReflection.mutateAsync({ ritualInstanceId: instance.id, promptKey: 'highlight', body: highlight.trim() })
      } catch (err) {
        toast.error((err as Error).message || 'Failed to save highlight')
        return
      }
    }
    setStep('confirm')
  }

  async function quickAddTask() {
    const title = newTaskTitle.trim()
    if (!title || createTask.isPending) return
    try {
      const res = await createTask.mutateAsync({
        title,
        scheduledDate: today,
        scheduledBucket: 'TODAY',
      } as any)
      const id = (res as any)?.data?.id
      if (id) setSelectedTaskIds((prev) => new Set(prev).add(id))
      setNewTaskTitle('')
    } catch (err) {
      toast.error((err as Error).message || t('dailyPlan.addTaskFailed', { defaultValue: 'Failed to add task' }))
    }
  }

  function toggleTask(id: string) {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function planAndComplete() {
    setPlanning(true)
    const toSchedule = openTasks.filter((t) => selectedTaskIds.has(t.id) && !t.scheduledStart)
    let scheduled = 0
    let failed = 0
    let lastError: unknown = null
    for (const task of toSchedule) {
      try {
        const r = await schedulingApi.autoSchedule({ taskId: task.id, day: today })
        if (r.type === 'Success') scheduled++
        else {
          failed++
          lastError = new Error((r as any)?.reason || 'Auto-schedule rejected')
        }
      } catch (err) {
        failed++
        lastError = err
      }
    }
    qc.invalidateQueries({ queryKey: ['tasks'] })
    qc.invalidateQueries({ queryKey: schedulingKeys.sessions })

    if (failed > 0 && lastError) {
      const detail = lastError instanceof Error ? lastError.message : ''
      if (detail) {
        toast.error(`${t('dailyPlan.scheduleFailedDetail', { count: failed, detail, defaultValue: "Couldn't schedule {{count}} ({{detail}})" })}`)
      }
    }

    try {
      await updateInstance.mutateAsync({
        id: instance.id,
        body: {
          status: 'COMPLETED',
          completedAt: new Date().toISOString(),
          snapshot: { highlight: highlight.trim() || null, selectedTaskIds: Array.from(selectedTaskIds), scheduled, failed },
        },
      })
    } catch (err) {
      toast.error((err as Error).message || 'Failed to save ritual')
      setPlanning(false)
      return
    }

    if (scheduled > 0 && failed === 0) toast.success(`Day planned · ${scheduled} task${scheduled === 1 ? '' : 's'} scheduled`)
    else if (scheduled > 0 && failed > 0) toast.success(`Scheduled ${scheduled} · ${failed} couldn't fit`)
    else if (scheduled === 0 && failed === 0) toast.success('Day planned')
    else toast.warning(`Couldn't schedule ${failed} task${failed === 1 ? '' : 's'}`)

    setPlanning(false)
    setStep('done')
    onClose()
  }

  async function skip() {
    try {
      await updateInstance.mutateAsync({ id: instance.id, body: { status: 'SKIPPED' } })
      onClose()
    } catch (err) {
      toast.error((err as Error).message || 'Failed to skip')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('dailyPlan.title', { defaultValue: 'Daily Plan' })}</DialogTitle>
          <DialogDescription>
            {step === 'highlight' && t('dailyPlan.step1', { defaultValue: 'Step 1 of 3 — Set your highlight' })}
            {step === 'confirm' && t('dailyPlan.step2', { selected: selectedTaskIds.size, total: openTasks.length, defaultValue: "Step 2 of 3 — Confirm today's tasks ({{selected}}/{{total}})" })}
            {step === 'plan' && t('dailyPlan.step3', { defaultValue: 'Step 3 of 3 — Plan the day' })}
          </DialogDescription>
        </DialogHeader>

        {step === 'highlight' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('dailyPlan.highlightHint', { defaultValue: 'The one thing that, if done, makes today a win.' })}
            </p>
            <textarea
              value={highlight}
              onChange={(e) => setHighlight(e.target.value)}
              rows={3}
              autoFocus
              placeholder={t('dailyPlan.highlightPlaceholder', { defaultValue: 'Today I want to…' })}
              className="w-full rounded-md border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={skip}>{t('buttons.skip', { defaultValue: 'Skip ritual' })}</Button>
              <Button onClick={saveHighlightAndAdvance}>{t('buttons.next', { defaultValue: 'Next' })}</Button>
            </div>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    quickAddTask()
                  }
                }}
                placeholder={t('dailyPlan.addTaskPlaceholder', { defaultValue: 'Add a task for today…' })}
                className="h-8 text-sm"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={quickAddTask}
                disabled={!newTaskTitle.trim() || createTask.isPending}
                className="h-8 shrink-0"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t('dailyPlan.addTask', { defaultValue: 'Add' })}
              </Button>
            </div>
            {openTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dailyPlan.noOpenTasks', { defaultValue: 'No open tasks for today yet. Add one above or capture with Cmd+K.' })}</p>
            ) : (
              <ul className="max-h-72 overflow-y-auto space-y-1 pr-1">
                {openTasks.map((task) => (
                  <li key={task.id}>
                    <label className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/30 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedTaskIds.has(task.id)}
                        onChange={() => toggleTask(task.id)}
                      />
                      <span className="text-sm break-words flex-1">{task.title}</span>
                      {task.scheduledStart ? (
                        <span className="text-[10px] uppercase text-muted-foreground">{t('scheduledLabel', { defaultValue: 'scheduled' })}</span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setStep('highlight')}>{t('buttons.back', { defaultValue: 'Back' })}</Button>
              <Button onClick={() => setStep('plan')}>{t('buttons.next', { defaultValue: 'Next' })}</Button>
            </div>
          </div>
        )}

        {step === 'plan' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('dailyPlan.planHint', { defaultValue: 'The engine will auto-schedule selected tasks into your working hours, respecting existing calendar events.' })}
            </p>
            <div className="rounded-md bg-muted/30 p-3 text-xs">
              <div>{t('dailyPlan.highlight', { defaultValue: 'Highlight' })}: <span className="font-medium">{highlight.trim() || t('dailyPlan.none', { defaultValue: '(none)' })}</span></div>
              <div>
                {t('dailyPlan.tasksToSchedule', { defaultValue: 'Tasks to schedule' })}:{' '}
                <span className="font-medium">
                  {openTasks.filter((task) => selectedTaskIds.has(task.id) && !task.scheduledStart).length}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setStep('confirm')} disabled={planning}>{t('buttons.back', { defaultValue: 'Back' })}</Button>
              <Button onClick={planAndComplete} disabled={planning}>
                {planning ? t('dailyPlan.planning', { defaultValue: 'Planning…' }) : t('dailyPlan.planDay', { defaultValue: 'Plan the day' })}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
