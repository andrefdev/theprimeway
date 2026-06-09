import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { differenceInMinutes, format, isSameDay } from 'date-fns'
import { ChevronDown } from 'lucide-react'
import {
  useDraggable,
  useDroppable,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core'
import { CheckIcon } from '@/shared/components/Icons'
import { useLocale } from '@/i18n/useLocale'
import { cn } from '@/shared/lib/utils'
import { getItemsForDay, type CalendarItem } from '../../hooks/use-calendar-items'
import { resolveItemColor, withAlpha } from '../../lib/colors'
import {
  HOUR_HEIGHT,
  HOURS,
  LABEL_WIDTH,
  SLOT_MINUTES,
  START_HOUR,
  END_HOUR,
  TOTAL_HEIGHT,
  layoutItems,
} from './constants'
import { localTimeToUtc } from '@repo/shared/utils'
import { useUserTimezone } from '@/features/settings/hooks/use-user-timezone'

function slotStartFromMinutes(day: Date, totalMinutes: number, tz: string): Date {
  const startMin = START_HOUR * 60 + totalMinutes
  const hh = String(Math.floor(startMin / 60)).padStart(2, '0')
  const mm = String(startMin % 60).padStart(2, '0')
  return localTimeToUtc(day, `${hh}:${mm}`, tz)
}

interface TimeGridProps {
  days: Date[]
  items: CalendarItem[]
  today: Date
  onSlotClick: (start: Date) => void
  onItemClick: (item: CalendarItem, anchor: HTMLElement) => void
  /**
   * When provided, each 30-min slot becomes a droppable target with id
   * `slot-{ISO}` so a parent DndContext can route task-list drops here.
   */
  enableSlotDrop?: boolean
  /**
   * When true, in-app session blocks become draggable (id `calitem:{taskId}`,
   * data `{ type: 'calitem', taskId }`) so a parent DndContext can reschedule
   * them by re-using the same slot-drop handling as task-list drags. Only
   * `session` items with a linked task are draggable — external Google events
   * stay read-only. Requires the caller to wrap TimeGrid in a DndContext.
   */
  enableItemDrag?: boolean
  /** Visual band representing the working-hours window for the day. */
  dayStartHour?: number
  dayEndHour?: number
  /**
   * When provided, top/bottom drag handles appear on the working-hours band.
   * Receives clock hours [0-24] in 0.5h steps. Caller persists the override.
   */
  onDayBoundsChange?: (next: { startHour: number; endHour: number }) => void
}

const ALL_DAY_COLLAPSED_LIMIT = 2

export function TimeGrid({
  days,
  items,
  today,
  onSlotClick,
  onItemClick,
  enableSlotDrop = false,
  enableItemDrag = false,
  dayStartHour,
  dayEndHour,
  onDayBoundsChange,
}: TimeGridProps) {
  const tz = useUserTimezone()
  const { dateFnsLocale } = useLocale()
  const { t } = useTranslation('calendar')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => new Date())
  const [allDayExpanded, setAllDayExpanded] = useState(false)

  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(i)
  }, [])

  useEffect(() => {
    if (!scrollRef.current) return
    const hasToday = days.some((d) => isSameDay(d, today))
    if (!hasToday) {
      scrollRef.current.scrollTop = 7 * HOUR_HEIGHT
      return
    }
    const nowH = today.getHours() + today.getMinutes() / 60
    scrollRef.current.scrollTop = Math.max(0, (nowH - 1) * HOUR_HEIGHT)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0]?.getTime()])

  const gridCols = `${LABEL_WIDTH}px repeat(${days.length}, minmax(0, 1fr))`

  const dayBuckets = useMemo(
    () =>
      days.map((day) => {
        const dayItems = getItemsForDay(items, day)
        const allDay = dayItems.filter((i) => i.isAllDay)
        const timed = dayItems.filter((i) => !i.isAllDay)
        return { day, allDay, timed, laidOut: layoutItems(timed) }
      }),
    [days, items],
  )

  const hasAllDay = useMemo(() => dayBuckets.some((b) => b.allDay.length > 0), [dayBuckets])
  const maxAllDayCount = useMemo(
    () => dayBuckets.reduce((m, b) => Math.max(m, b.allDay.length), 0),
    [dayBuckets],
  )
  const canCollapse = maxAllDayCount > ALL_DAY_COLLAPSED_LIMIT

  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="grid" style={{ gridTemplateColumns: gridCols }}>
          <div />
          {days.map((day) => {
            const isToday = isSameDay(day, today)
            return (
              <div
                key={day.toISOString()}
                className={cn(
                  'px-2 py-2 text-center border-l border-border',
                  isToday && 'bg-primary/5',
                )}
              >
                <p className="text-[10px] uppercase text-muted-foreground tracking-wide">
                  {format(day, 'EEE', { locale: dateFnsLocale })}
                </p>
                <p
                  className={cn(
                    'text-xl font-semibold',
                    isToday ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {format(day, 'd')}
                </p>
              </div>
            )
          })}
        </div>

        {hasAllDay && (
          <div className="grid border-t border-border" style={{ gridTemplateColumns: gridCols }}>
            <div className="flex flex-col items-end pr-2 py-1 self-start pt-1 gap-1">
              <span className="text-[9px] uppercase text-muted-foreground tracking-wide">
                {t('allDay')}
              </span>
              {canCollapse && (
                <button
                  type="button"
                  onClick={() => setAllDayExpanded((v) => !v)}
                  className="rounded-full p-0.5 hover:bg-muted text-muted-foreground transition-colors"
                  title={
                    allDayExpanded
                      ? t('collapse', { defaultValue: 'Collapse' })
                      : t('expand', { defaultValue: 'Expand' })
                  }
                  aria-label={
                    allDayExpanded
                      ? t('collapse', { defaultValue: 'Collapse' })
                      : t('expand', { defaultValue: 'Expand' })
                  }
                  aria-expanded={allDayExpanded}
                >
                  <ChevronDown
                    size={14}
                    className={cn(
                      'transition-transform duration-150',
                      allDayExpanded ? 'rotate-180' : 'rotate-0',
                    )}
                  />
                </button>
              )}
            </div>
            {dayBuckets.map(({ day, allDay }) => {
              const collapsed = canCollapse && !allDayExpanded
              const visible = collapsed ? allDay.slice(0, ALL_DAY_COLLAPSED_LIMIT) : allDay
              const overflow = allDay.length - visible.length
              return (
                <div
                  key={day.toISOString()}
                  className="border-l border-border p-1 space-y-0.5 min-h-[28px]"
                >
                  {visible.map((item) => (
                    <AllDayChip key={item.id} item={item} onItemClick={onItemClick} />
                  ))}
                  {overflow > 0 && (
                    <button
                      type="button"
                      onClick={() => setAllDayExpanded(true)}
                      className="w-full text-left text-[10px] font-medium text-muted-foreground hover:text-foreground px-1.5 py-0.5"
                    >
                      {t('moreCount', { count: overflow, defaultValue: `${overflow} more` })}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div
        className="grid relative"
        style={{ gridTemplateColumns: gridCols, height: TOTAL_HEIGHT }}
      >
        <div className="relative">
          {HOURS.map((h, i) => (
            <div
              key={h}
              className="absolute right-2 -translate-y-1/2 text-xs font-medium text-muted-foreground"
              style={{ top: i * HOUR_HEIGHT }}
            >
              {i === 0 ? '' : format(new Date(2000, 0, 1, h), 'h a', { locale: dateFnsLocale })}
            </div>
          ))}
        </div>

        {dayBuckets.map(({ day, laidOut }) => {
          const isToday = isSameDay(day, today)
          const showBand = dayStartHour != null && dayEndHour != null
          const bandTop = showBand ? (dayStartHour! - START_HOUR) * HOUR_HEIGHT : 0
          const bandHeight = showBand ? (dayEndHour! - dayStartHour!) * HOUR_HEIGHT : 0

          return (
            <div
              key={day.toISOString()}
              className={cn(
                'relative border-l border-border cursor-pointer',
                isToday && 'bg-primary/[0.03]',
              )}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('[data-event]')) return
                if ((e.target as HTMLElement).closest('[data-day-handle]')) return
                const rect = e.currentTarget.getBoundingClientRect()
                const y = e.clientY - rect.top
                const totalMinutes = (y / HOUR_HEIGHT) * 60
                const snapped = Math.floor(totalMinutes / SLOT_MINUTES) * SLOT_MINUTES
                const start = slotStartFromMinutes(day, snapped, tz)
                onSlotClick(start)
              }}
            >
              {showBand && (
                <div
                  className="absolute left-0 right-0 bg-primary/5 pointer-events-none"
                  style={{ top: bandTop, height: bandHeight }}
                />
              )}

              {HOURS.map((h, i) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 border-t border-border/40"
                  style={{ top: i * HOUR_HEIGHT }}
                />
              ))}

              {enableSlotDrop &&
                Array.from({ length: HOURS.length * (60 / SLOT_MINUTES) }).map((_, idx) => {
                  const slotStart = slotStartFromMinutes(day, idx * SLOT_MINUTES, tz)
                  return (
                    <SlotDroppable
                      key={idx}
                      start={slotStart}
                      top={(idx * SLOT_MINUTES * HOUR_HEIGHT) / 60}
                      height={(SLOT_MINUTES * HOUR_HEIGHT) / 60}
                    />
                  )
                })}

              {showBand && onDayBoundsChange && (
                <DayBoundHandle
                  position="top"
                  top={bandTop}
                  onChange={(deltaPx) => {
                    const deltaHours = (deltaPx / HOUR_HEIGHT) * 2
                    const next = clampHour(Math.round((dayStartHour! + deltaHours) * 2) / 2)
                    if (next < dayEndHour!) onDayBoundsChange({ startHour: next, endHour: dayEndHour! })
                  }}
                />
              )}
              {showBand && onDayBoundsChange && (
                <DayBoundHandle
                  position="bottom"
                  top={bandTop + bandHeight}
                  onChange={(deltaPx) => {
                    const deltaHours = (deltaPx / HOUR_HEIGHT) * 2
                    const next = clampHour(Math.round((dayEndHour! + deltaHours) * 2) / 2)
                    if (next > dayStartHour!) onDayBoundsChange({ startHour: dayStartHour!, endHour: next })
                  }}
                />
              )}

              {laidOut.map(({ item, col, cols }) => {
                const draggable =
                  enableItemDrag && item.type === 'session' && !!item.task?.id
                return draggable ? (
                  <DraggableEventBlock
                    key={item.id}
                    item={item}
                    col={col}
                    cols={cols}
                    onItemClick={onItemClick}
                  />
                ) : (
                  <EventBlock
                    key={item.id}
                    item={item}
                    col={col}
                    cols={cols}
                    onItemClick={onItemClick}
                  />
                )
              })}

              {isToday && (() => {
                const nowHour = now.getHours() + now.getMinutes() / 60
                if (nowHour < START_HOUR || nowHour > END_HOUR) return null
                const top = (nowHour - START_HOUR) * HOUR_HEIGHT
                return (
                  <div className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top }}>
                    <div className="h-0.5 bg-destructive" />
                    <div className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-destructive" />
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function clampHour(h: number): number {
  if (h < 0) return 0
  if (h > 24) return 24
  return h
}

interface EventBlockDrag {
  setNodeRef: (el: HTMLElement | null) => void
  listeners: DraggableSyntheticListeners
  attributes: DraggableAttributes
  isDragging: boolean
}

function EventBlock({
  item,
  col,
  cols,
  onItemClick,
  drag,
}: {
  item: CalendarItem
  col: number
  cols: number
  onItemClick: (item: CalendarItem, anchor: HTMLElement) => void
  drag?: EventBlockDrag
}) {
  const startHour = item.start.getHours() + item.start.getMinutes() / 60
  const durationMin = Math.max(differenceInMinutes(item.end, item.start), 15)
  const top = Math.max((startHour - START_HOUR) * HOUR_HEIGHT, 0)
  const height = Math.max((durationMin / 60) * HOUR_HEIGHT, 20)
  const hex = resolveItemColor(item)
  const widthPct = 100 / cols
  const leftPct = col * widthPct

  return (
    <div
      ref={drag?.setNodeRef}
      data-event
      onClick={(e) => {
        e.stopPropagation()
        onItemClick(item, e.currentTarget)
      }}
      {...(drag?.listeners ?? {})}
      {...(drag?.attributes ?? {})}
      className={cn(
        'absolute rounded-md border-l-[3px] px-1.5 py-0.5 overflow-hidden hover:shadow-md transition-shadow',
        drag ? 'cursor-grab active:cursor-grabbing touch-none' : 'cursor-pointer',
      )}
      style={{
        top: top + 1,
        height: height - 2,
        left: `calc(${leftPct}% + 3px)`,
        width: `calc(${widthPct}% - 6px)`,
        backgroundColor: withAlpha(hex),
        borderLeftColor: hex,
        opacity: drag?.isDragging ? 0.4 : undefined,
      }}
      title={`${item.title} (${format(item.start, 'h:mm a')} – ${format(item.end, 'h:mm a')})`}
    >
      <div className="flex items-start gap-1">
        {item.status === 'completed' && (
          <CheckIcon size={8} className="text-emerald-500 mt-0.5 flex-shrink-0" />
        )}
        <span
          className={cn(
            'text-[11px] font-medium leading-tight truncate',
            item.status === 'completed'
              ? 'line-through text-muted-foreground'
              : 'text-foreground',
          )}
        >
          {item.title}
        </span>
      </div>
      {height >= HOUR_HEIGHT && (
        <span className="text-[9px] text-muted-foreground">
          {format(item.start, 'h:mm')}
        </span>
      )}
    </div>
  )
}

/**
 * Draggable variant — only rendered for in-app session blocks inside a
 * DndContext (tasks/today). The `useDraggable` hook is isolated here so it
 * never runs in the read-only week calendar (which has no DndContext).
 */
function DraggableEventBlock(props: {
  item: CalendarItem
  col: number
  cols: number
  onItemClick: (item: CalendarItem, anchor: HTMLElement) => void
}) {
  const taskId = props.item.task!.id
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `calitem:${taskId}`,
    data: { type: 'calitem', taskId },
  })
  return (
    <EventBlock
      {...props}
      drag={{ setNodeRef, listeners, attributes, isDragging }}
    />
  )
}

function SlotDroppable({ start, top, height }: { start: Date; top: number; height: number }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `slot-${start.toISOString()}`,
    data: { start: start.toISOString() },
  })
  return (
    <div
      ref={setNodeRef}
      className={cn('absolute left-0 right-0 pointer-events-auto', isOver && 'bg-primary/10')}
      style={{ top, height, zIndex: 1 }}
    />
  )
}

function DayBoundHandle({
  position,
  top,
  onChange,
}: {
  position: 'top' | 'bottom'
  top: number
  onChange: (deltaPx: number) => void
}) {
  const startY = useRef<number | null>(null)
  const [dragDeltaPx, setDragDeltaPx] = useState<number | null>(null)

  useEffect(() => {
    setDragDeltaPx(null)
  }, [top])

  return (
    <div
      data-day-handle
      className={cn(
        'absolute left-0 right-0 h-2 cursor-ns-resize z-20 group',
        position === 'top' ? '-translate-y-1' : '-translate-y-1',
      )}
      style={{ top: top + (dragDeltaPx ?? 0) }}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        startY.current = e.clientY
        setDragDeltaPx(0)
      }}
      onPointerMove={(e) => {
        if (startY.current == null) return
        setDragDeltaPx(e.clientY - startY.current)
      }}
      onPointerUp={(e) => {
        const delta = startY.current == null ? 0 : e.clientY - startY.current
        startY.current = null
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
        if (Math.abs(delta) >= HOUR_HEIGHT / 4) {
          onChange(delta)
        } else {
          setDragDeltaPx(null)
        }
      }}
    >
      <div className="h-0.5 bg-primary/40 group-hover:bg-primary transition-colors" />
    </div>
  )
}

function AllDayChip({
  item,
  onItemClick,
}: {
  item: CalendarItem
  onItemClick: (item: CalendarItem, anchor: HTMLElement) => void
}) {
  const hex = resolveItemColor(item)
  return (
    <button
      type="button"
      data-event
      onClick={(e) => {
        e.stopPropagation()
        onItemClick(item, e.currentTarget)
      }}
      style={{
        backgroundColor: withAlpha(hex),
        borderLeftColor: hex,
      }}
      className={cn(
        'w-full text-left rounded border-l-[3px] px-1.5 py-0.5 text-[11px] leading-tight truncate cursor-pointer hover:shadow-md transition-shadow',
        item.status === 'completed' && 'line-through text-muted-foreground',
      )}
      title={item.title}
    >
      {item.status === 'completed' && (
        <CheckIcon size={8} className="inline text-emerald-500 mr-0.5" />
      )}
      {item.title}
    </button>
  )
}
