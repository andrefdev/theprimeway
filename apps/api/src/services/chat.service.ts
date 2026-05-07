import { chatRepo, type PersistedToolCall } from '../repositories/chat.repo'
import { tasksRepository } from '../repositories/tasks.repo'
import { habitsRepository } from '../repositories/habits.repo'
import { goalsRepository } from '../repositories/goals.repo'
import { prisma } from '../lib/prisma'
import { generateObject, generateText, streamText, stepCountIs, convertToModelMessages } from 'ai'
import type { UIMessage } from 'ai'
import { chatModel, taskModel, visionModel } from '../lib/ai-models'
import { getAIContext } from '../lib/ai-context'
import { buildBasePreamble } from '../lib/ai-prompts'
import { z } from 'zod'
import { calendarService } from './calendar.service'
import { endOfLocalDayUtc, startOfLocalDayUtc } from '@repo/shared/utils'
import { chatTitleService } from './chat-title.service'
import { buildStreamTools, buildServerTools } from '../lib/ai-tools'

function extractUiMessageText(msg: UIMessage | { role: string; content?: string; parts?: any[] }): string {
  const anyMsg = msg as any
  if (typeof anyMsg.content === 'string' && anyMsg.content.length > 0) {
    return anyMsg.content
  }
  const parts: Array<{ type: string; text?: string }> = anyMsg.parts ?? []
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n')
}

function hasImageAttachments(messages: UIMessage[] | { parts?: any[] }[]): boolean {
  for (const msg of messages) {
    const parts: Array<{ type: string; mediaType?: string }> = (msg as any).parts ?? []
    for (const part of parts) {
      if (part.type === 'image') return true
      if (part.type === 'file' && typeof part.mediaType === 'string' && part.mediaType.startsWith('image/')) {
        return true
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Rate limiter (simple in-memory)
// ---------------------------------------------------------------------------
const rateLimit = new Map<string, { count: number; lastReset: number }>()
let lastCleanup = Date.now()

const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute
const MAX_REQUESTS = 15
const CLEANUP_INTERVAL = 5 * 60 * 1000

function cleanupRateLimit() {
  const now = Date.now()
  if (now - lastCleanup < CLEANUP_INTERVAL) return
  lastCleanup = now
  for (const [key, value] of Array.from(rateLimit.entries())) {
    if (now - value.lastReset > RATE_LIMIT_WINDOW * 2) {
      rateLimit.delete(key)
    }
  }
}

class ChatService {
  checkRateLimit(userId: string): boolean {
    cleanupRateLimit()
    const now = Date.now()
    const userLimit = rateLimit.get(userId) || { count: 0, lastReset: now }

    if (now - userLimit.lastReset > RATE_LIMIT_WINDOW) {
      userLimit.count = 0
      userLimit.lastReset = now
    }

    if (userLimit.count >= MAX_REQUESTS) {
      return false
    }

    userLimit.count++
    rateLimit.set(userId, userLimit)
    return true
  }

  async checkAiDataSharing(userId: string): Promise<boolean> {
    const userSettings = await chatRepo.findUserSettings(userId)
    return userSettings?.aiDataSharing ?? true
  }

  async buildSystemPrompt(userId: string) {
    const [ctx, openTasks, activeHabits] = await Promise.all([
      getAIContext(userId),
      tasksRepository.findOpenTasks(userId, 20),
      habitsRepository.findActiveHabits(userId),
    ])

    const taskContext = openTasks
      .map((t) => `- [${t.id}] "${t.title}" (priority: ${t.priority}, due: ${t.dueDate || 'none'})`)
      .join('\n')

    const habitContext = activeHabits
      .map((h) => `- [${h.id}] "${h.name}" (frequency: ${h.frequencyType || 'daily'}, target: ${h.targetFrequency || 1})`)
      .join('\n')

    return `${buildBasePreamble(ctx)}

ROLE
You are a productivity assistant for ThePrimeWay. You help the user manage their tasks and habits. Be concise, actionable, and encouraging.

User's open tasks:
${taskContext || '(no open tasks)'}

User's active habits:
${habitContext || '(no active habits)'}

Available tools span tasks, habits, goals, calendar, and pomodoro.

Read tools (run automatically, no confirmation): listTasks, listHabits, listGoals, listCalendarEvents, findFreeSlots.
Write tools (require user approval in UI): createTask, updateTask, deleteTask, completeTask, createHabit, updateHabit, logHabit, createGoal, updateGoalProgress, createTimeBlock, updateCalendarEvent, deleteCalendarEvent, startPomodoro.

Workflow:
1. If you need current data (list of habits, goals, events, free slots), call a read tool first — do NOT guess IDs.
2. Propose writes only after you have the relevant IDs. The user will accept or reject; summarize the outcome afterward.
3. Do NOT invent IDs. Use IDs from context above or from tool results.`
  }

  /**
   * Streaming chat for the agentic UI. Read-only tools execute on the server;
   * destructive tools are declared without an execute function so the client
   * can render a confirmation UI and call the corresponding REST endpoint
   * only when the user accepts.
   */
  async chatStream(
    userId: string,
    body: { messages: UIMessage[]; threadId?: string },
  ) {
    const system = await this.buildSystemPrompt(userId)

    let thread = body.threadId
      ? await chatRepo.findThreadById(userId, body.threadId)
      : null
    if (!thread) thread = await chatRepo.createThread(userId)
    const threadId = thread.id
    const wasTitled = !!thread.title

    const lastMsg = body.messages[body.messages.length - 1]
    if (lastMsg && lastMsg.role === 'user') {
      const text = extractUiMessageText(lastMsg)
      if (text) {
        try {
          await chatRepo.appendMessage(threadId, { role: 'user', content: text })
          await chatRepo.touchThread(threadId)
        } catch (err) {
          console.error('[chat] failed to persist user message', err)
        }
      }
    }

    const modelForRequest = hasImageAttachments(body.messages) ? visionModel : chatModel

    const stream = streamText({
      model: modelForRequest,
      system,
      messages: convertToModelMessages(body.messages),
      tools: buildStreamTools(userId),
      stopWhen: stepCountIs(5),
      onFinish: async ({ text, steps }) => {
        try {
          const toolCalls: PersistedToolCall[] = []
          for (const step of (steps ?? []) as any[]) {
            const calls = (step.toolCalls ?? []) as any[]
            const results = (step.toolResults ?? []) as any[]
            for (const call of calls) {
              const matching = results.find((r: any) => r.toolCallId === call.toolCallId)
              const args = call.input ?? call.args
              const resultValue = matching ? (matching.output ?? matching.result) : undefined
              toolCalls.push({
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                args,
                result: resultValue,
              })
            }
          }
          await chatRepo.appendMessage(threadId, {
            role: 'assistant',
            content: text ?? '',
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          })
          await chatRepo.touchThread(threadId)
          if (!wasTitled) {
            chatTitleService.generate(userId, threadId).catch(() => {})
          }
        } catch (err) {
          console.error('[chat] onFinish persistence failed', err)
        }
      },
    })

    return { stream, threadId }
  }

  async chat(
    userId: string,
    body: { messages: { role: 'user' | 'assistant'; content: string }[] },
  ) {
    const [ctx, openTasks, activeHabits] = await Promise.all([
      getAIContext(userId),
      tasksRepository.findOpenTasks(userId, 20),
      habitsRepository.findActiveHabits(userId),
    ])

    const taskContext = openTasks
      .map((t) => `- [${t.id}] "${t.title}" (priority: ${t.priority}, due: ${t.dueDate || 'none'})`)
      .join('\n')

    const habitContext = activeHabits
      .map((h) => `- [${h.id}] "${h.name}" (frequency: ${h.frequencyType || 'daily'}, target: ${h.targetFrequency || 1})`)
      .join('\n')

    const systemPrompt = `${buildBasePreamble(ctx)}

ROLE
You are a productivity assistant for ThePrimeWay. You help the user manage their tasks and habits. Be concise, actionable, and encouraging.

User's open tasks:
${taskContext || '(no open tasks)'}

User's active habits:
${habitContext || '(no active habits)'}

When the user asks you to create, complete, or list tasks or habits, use the available tools.
After using a tool, summarize what you did in your response.
Do NOT invent task or habit IDs — only reference IDs from the context above or from tool results.`

    const result = await generateText({
      model: chatModel,
      system: systemPrompt,
      messages: body.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      tools: buildServerTools(userId),
      stopWhen: stepCountIs(5),
    })

    // Collect tool results from all steps
    const toolResults = result.steps
      .flatMap((step) => step.toolResults)
      .filter(Boolean)

    return {
      response: result.text,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
    }
  }

  async weeklyPlanning(userId: string, weekStartDate: string) {
    const settings = await prisma.userSettings.findUnique({
      where: { userId },
      select: { timezone: true },
    })
    const tz = settings?.timezone ?? 'UTC'
    const weekStart = startOfLocalDayUtc(new Date(weekStartDate), tz)
    const weekEndAnchor = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000)
    const weekEnd = endOfLocalDayUtc(weekEndAnchor, tz)

    const [ctx, quarterlyGoals, habits, openTasks, workingHours] = await Promise.all([
      getAIContext(userId),
      goalsRepository.findActiveQuarterlyGoals(userId),
      habitsRepository.findActiveHabits(userId),
      tasksRepository.findOpenTasks(userId, 100),
      prisma.workingHours.findMany({ where: { userId, channelId: null }, orderBy: { dayOfWeek: 'asc' } }),
    ])

    // Get calendar availability for the week
    const freeSlots: Record<string, { start: string; end: string; durationMinutes: number }[]> = {}
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(weekStart)
      dayDate.setDate(dayDate.getDate() + i)
      const dateStr = dayDate.toISOString().split('T')[0]!
      const result = await calendarService.getFreeSlots(userId, dateStr, 60)
      freeSlots[dayNames[i]!] = (result as any).freeSlots || []
    }

    // Prepare task context for AI
    const taskContext = openTasks
      .slice(0, 20)
      .map((t) => `- ${t.title} (priority: ${t.priority}, deadline: ${t.dueDate || 'no deadline'})`)
      .join('\n')

    const habitContext = habits
      .map((h) => `- ${h.name} (frequency: ${h.targetFrequency || h.frequencyType || 'daily'})`)
      .join('\n')

    const goalContext = quarterlyGoals
      .slice(0, 5)
      .map((g) => `- ${g.title} (progress: ${Math.round((g.visionContribution ?? 0) * 100)}%)`)
      .join('\n')

    const firstDay = workingHours[0]
    const workHours = firstDay ? `${firstDay.startTime} - ${firstDay.endTime}` : '09:00 - 17:00'

    const result = await generateObject({
      model: taskModel,
      schema: z.object({
        plan: z.object({
          Monday: z.array(z.object({ title: z.string(), timeBlock: z.string().optional() })),
          Tuesday: z.array(z.object({ title: z.string(), timeBlock: z.string().optional() })),
          Wednesday: z.array(z.object({ title: z.string(), timeBlock: z.string().optional() })),
          Thursday: z.array(z.object({ title: z.string(), timeBlock: z.string().optional() })),
          Friday: z.array(z.object({ title: z.string(), timeBlock: z.string().optional() })),
          Saturday: z.array(z.object({ title: z.string(), timeBlock: z.string().optional() })),
          Sunday: z.array(z.object({ title: z.string(), timeBlock: z.string().optional() })),
        }),
        rationale: z.string(),
      }),
      system: buildBasePreamble(ctx),
      prompt: `
Create a weekly plan for ${weekStartDate} to ${weekEnd.toISOString().split('T')[0]}.

Work hours: ${workHours}

Active Goals:
${goalContext || 'No active goals'}

Daily Habits:
${habitContext || 'No habits'}

Open Tasks (prioritized):
${taskContext || 'No open tasks'}

Allocate tasks and habits across the 7 days based on:
1. Task deadlines and priorities
2. Habit frequencies and best times of day
3. Goal alignment
4. Available calendar slots

Return a coherent week plan with tasks/habits distributed by day. Include time blocks when possible.
      `,
    })

    return result.object
  }
}

export const chatService = new ChatService()
