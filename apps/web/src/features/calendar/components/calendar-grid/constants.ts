import type { CalendarItem } from '../../hooks/use-calendar-items'

export const SLOT_MINUTES = 30
export const HOUR_HEIGHT = 80
export const START_HOUR = 0
export const END_HOUR = 24
export const LABEL_WIDTH = 56
export const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i)
export const TOTAL_HEIGHT = HOURS.length * HOUR_HEIGHT

export interface LaidOutItem {
  item: CalendarItem
  col: number
  cols: number
}

export function layoutItems(items: CalendarItem[]): LaidOutItem[] {
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime())
  const result: LaidOutItem[] = []
  let cluster: LaidOutItem[] = []
  let clusterEnd = 0

  function flush() {
    const cols = cluster.reduce((m, c) => Math.max(m, c.col + 1), 0)
    for (const c of cluster) c.cols = cols
    result.push(...cluster)
    cluster = []
  }

  for (const item of sorted) {
    const start = item.start.getTime()
    const end = item.end.getTime()
    if (cluster.length === 0 || start >= clusterEnd) {
      flush()
      cluster.push({ item, col: 0, cols: 1 })
      clusterEnd = end
      continue
    }
    const usedCols = new Set(
      cluster.filter((c) => c.item.end.getTime() > start).map((c) => c.col),
    )
    let col = 0
    while (usedCols.has(col)) col++
    cluster.push({ item, col, cols: 1 })
    clusterEnd = Math.max(clusterEnd, end)
  }
  flush()
  return result
}
