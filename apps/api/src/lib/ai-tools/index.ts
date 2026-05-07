/**
 * Chat AI tools — domain-grouped factories.
 *
 * Two flavours:
 *  - buildStreamTools(userId): read tools execute server-side; write tools are
 *    declared without `execute` so the agentic UI renders a confirmation step
 *    and calls the relevant REST endpoint when the user accepts.
 *  - buildServerTools(userId): a small set of server-execute tools used by the
 *    legacy non-streaming chat() endpoint.
 */
import { taskReadTools, taskClientTools, taskServerTools } from './tasks.tools'
import { habitReadTools, habitClientTools, habitServerTools } from './habits.tools'
import { goalReadTools, goalClientTools } from './goals.tools'
import { calendarReadTools, calendarClientTools } from './calendar.tools'
import { pomodoroClientTools } from './pomodoro.tools'
import { brainClientTools } from './brain.tools'

export function buildStreamTools(userId: string) {
  return {
    ...taskReadTools(userId),
    ...habitReadTools(userId),
    ...goalReadTools(userId),
    ...calendarReadTools(userId),
    ...taskClientTools(),
    ...habitClientTools(),
    ...goalClientTools(),
    ...calendarClientTools(),
    ...pomodoroClientTools(),
    ...brainClientTools(),
  }
}

export function buildServerTools(userId: string) {
  return {
    ...taskReadTools(userId),
    ...taskServerTools(userId),
    ...habitServerTools(userId),
  }
}
