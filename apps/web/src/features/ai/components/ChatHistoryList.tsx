import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { MoreVertical, Pencil, Trash2, Trash } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/shared/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip'
import {
  aiQueries,
  useDeleteAllThreadsMutation,
  useDeleteThreadMutation,
  useRenameThreadMutation,
} from '../queries'
import type { ChatThreadSummary } from '../api'

type Bucket = 'today' | 'yesterday' | 'lastWeek' | 'older'

function bucketFor(iso: string | null): Bucket {
  if (!iso) return 'older'
  const d = new Date(iso)
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000)
  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return 'lastWeek'
  return 'older'
}

const BUCKET_ORDER: Bucket[] = ['today', 'yesterday', 'lastWeek', 'older']

export function ChatHistoryList({
  activeThreadId,
  onSelect,
}: {
  activeThreadId: string | undefined
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation('ai')
  const { data: threads, isLoading } = useQuery(aiQueries.threads())
  const renameM = useRenameThreadMutation()
  const deleteM = useDeleteThreadMutation()
  const deleteAllM = useDeleteAllThreadsMutation()
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ChatThreadSummary | null>(null)

  const grouped = useMemo(() => {
    const groups: Record<Bucket, ChatThreadSummary[]> = {
      today: [],
      yesterday: [],
      lastWeek: [],
      older: [],
    }
    for (const th of threads ?? []) {
      groups[bucketFor(th.lastMessageAt ?? th.createdAt)].push(th)
    }
    return groups
  }, [threads])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="flex-1">
        <div className="px-2 py-2">
          {isLoading && <ChatHistorySkeleton />}
          {!isLoading && (!threads || threads.length === 0) && (
            <div className="px-3 py-12 text-center text-sm text-muted-foreground">
              {t('historyEmpty')}
            </div>
          )}
          {BUCKET_ORDER.map((bucket) => {
            const items = grouped[bucket]
            if (items.length === 0) return null
            return (
              <div key={bucket} className="mb-3">
                <h3 className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t(bucket)}
                </h3>
                <ul className="space-y-0.5">
                  {items.map((th) => (
                    <ThreadRow
                      key={th.id}
                      thread={th}
                      isActive={th.id === activeThreadId}
                      onClick={() => onSelect(th.id)}
                      onRenameStart={() => setRenaming({ id: th.id, title: th.title ?? '' })}
                      onDeleteStart={() => setPendingDelete(th)}
                    />
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </ScrollArea>

      {threads && threads.length > 0 && (
        <div className="px-3 py-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-destructive hover:text-destructive"
              >
                <Trash className="mr-2 size-4" /> {t('clearAll')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('clearAllConfirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>{t('clearAllConfirm')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('back')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteAllM.mutate()}>
                  {t('delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      <RenameDialog
        renaming={renaming}
        onClose={() => setRenaming(null)}
        onSave={(title) => {
          if (renaming) renameM.mutate({ id: renaming.id, title })
          setRenaming(null)
        }}
      />

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingDelete?.title ?? t('untitled')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('back')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) deleteM.mutate(pendingDelete.id)
                setPendingDelete(null)
              }}
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ChatHistorySkeleton({
  buckets = 2,
  rowsPerBucket = 3,
}: {
  buckets?: number
  rowsPerBucket?: number
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      {Array.from({ length: buckets }).map((_, b) => (
        <div key={b} className="mb-3">
          <Skeleton className="mx-3 mb-1 mt-2 h-3 w-16" />
          <ul className="space-y-0.5">
            {Array.from({ length: rowsPerBucket }).map((_, r) => (
              <li
                key={r}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5"
              >
                <Skeleton
                  className="h-4 flex-1"
                  style={{ maxWidth: `${55 + ((b * 7 + r * 13) % 35)}%` }}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function ThreadRow({
  thread,
  isActive,
  onClick,
  onRenameStart,
  onDeleteStart,
}: {
  thread: ChatThreadSummary
  isActive: boolean
  onClick: () => void
  onRenameStart: () => void
  onDeleteStart: () => void
}) {
  const { t } = useTranslation('ai')
  const title = thread.title ?? t('untitled')
  return (
    <li
      className={`group relative flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-muted ${
        isActive ? 'bg-muted' : ''
      }`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className="flex flex-1 items-center text-left"
          >
            <span className="line-clamp-1 text-sm">{title}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="max-w-[280px] break-words">
          {title}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label={t('actions', { defaultValue: 'Actions' })}
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onRenameStart}>
            <Pencil className="mr-2 size-3.5" /> {t('rename')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDeleteStart} className="text-destructive">
            <Trash2 className="mr-2 size-3.5" /> {t('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

function RenameDialog({
  renaming,
  onClose,
  onSave,
}: {
  renaming: { id: string; title: string } | null
  onClose: () => void
  onSave: (title: string) => void
}) {
  const { t } = useTranslation('ai')
  const [value, setValue] = useState('')

  useEffect(() => {
    if (renaming) setValue(renaming.title)
    else setValue('')
  }, [renaming])

  return (
    <Dialog open={!!renaming} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('rename')}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) onSave(value.trim())
          }}
          maxLength={100}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('back')}
          </Button>
          <Button onClick={() => value.trim() && onSave(value.trim())} disabled={!value.trim()}>
            {t('rename')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
