import type { ToolHandler } from './types';
import { saveBrainIdeaHandler } from './handlers/brain';
import {
  createTaskHandler,
  updateTaskHandler,
  completeTaskHandler,
  deleteTaskHandler,
} from './handlers/tasks';
import {
  createHabitHandler,
  updateHabitHandler,
  logHabitHandler,
  deleteHabitHandler,
} from './handlers/habits';
import {
  createGoalHandler,
  updateGoalProgressHandler,
  deleteGoalHandler,
} from './handlers/goals';
import {
  createTimeBlockHandler,
  updateCalendarEventHandler,
  deleteCalendarEventHandler,
} from './handlers/calendar';
import { startPomodoroHandler } from './handlers/pomodoro';
import { autoScheduleTaskHandler } from './handlers/scheduling';

export const toolRegistry: Record<string, ToolHandler<never>> = {
  saveBrainIdea: saveBrainIdeaHandler as ToolHandler<never>,
  createTask: createTaskHandler as ToolHandler<never>,
  updateTask: updateTaskHandler as ToolHandler<never>,
  completeTask: completeTaskHandler as ToolHandler<never>,
  deleteTask: deleteTaskHandler as ToolHandler<never>,
  createHabit: createHabitHandler as ToolHandler<never>,
  updateHabit: updateHabitHandler as ToolHandler<never>,
  logHabit: logHabitHandler as ToolHandler<never>,
  deleteHabit: deleteHabitHandler as ToolHandler<never>,
  createGoal: createGoalHandler as ToolHandler<never>,
  updateGoalProgress: updateGoalProgressHandler as ToolHandler<never>,
  deleteGoal: deleteGoalHandler as ToolHandler<never>,
  createTimeBlock: createTimeBlockHandler as ToolHandler<never>,
  updateCalendarEvent: updateCalendarEventHandler as ToolHandler<never>,
  deleteCalendarEvent: deleteCalendarEventHandler as ToolHandler<never>,
  startPomodoro: startPomodoroHandler as ToolHandler<never>,
  autoScheduleTask: autoScheduleTaskHandler as ToolHandler<never>,
};
