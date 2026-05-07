import { toast } from 'sonner'
import type { SchedulingResult } from '../api'

type FailureKey = 'NO_WORKING_HOURS' | 'NO_GAPS' | 'WOULD_NOT_FIT' | 'UNKNOWN'

const MESSAGES: Record<FailureKey, (n: number) => string> = {
  NO_WORKING_HOURS: (n) =>
    `${n} task${n === 1 ? '' : 's'} skipped — no working hours set for this day`,
  NO_GAPS: (n) =>
    `${n} task${n === 1 ? '' : 's'} skipped — your day is already full`,
  WOULD_NOT_FIT: (n) =>
    `${n} task${n === 1 ? '' : 's'} too long for any free gap — try splitting or rescheduling`,
  UNKNOWN: (n) => `${n} task${n === 1 ? '' : 's'} failed to schedule`,
}

export function emptyFailureCounts(): Record<FailureKey, number> {
  return { NO_WORKING_HOURS: 0, NO_GAPS: 0, WOULD_NOT_FIT: 0, UNKNOWN: 0 }
}

export function classifyResult(
  result: SchedulingResult,
  failures: Record<FailureKey, number>,
) {
  if (result.type === 'Success') return true
  failures[result.reason] = (failures[result.reason] ?? 0) + 1
  return false
}

/** Single-task variant: report success or the specific failure reason. */
export function toastSchedulingResult(
  result: SchedulingResult,
  successMessage = 'Scheduled',
) {
  if (result.type === 'Success') {
    toast.success(successMessage)
    return
  }
  toast.warning(MESSAGES[result.reason](1))
}

/** Batch variant: aggregate counts across many auto-schedule calls. */
export function toastSchedulingBatch(
  okCount: number,
  failures: Record<FailureKey, number>,
) {
  if (okCount > 0) {
    toast.success(`Scheduled ${okCount} task${okCount === 1 ? '' : 's'}`)
  }
  for (const key of ['NO_WORKING_HOURS', 'NO_GAPS', 'WOULD_NOT_FIT'] as const) {
    if (failures[key] > 0) toast.warning(MESSAGES[key](failures[key]))
  }
  if (failures.UNKNOWN > 0) toast.error(MESSAGES.UNKNOWN(failures.UNKNOWN))
}
