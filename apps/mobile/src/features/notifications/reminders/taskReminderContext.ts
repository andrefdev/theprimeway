import type { Task } from '@shared/types/models';

const URL_RE = /https?:\/\/[^\s)]+/i;
const REPO_RE = /\b([\w-]+\/[\w.-]+)\b/;
const PREP_KEYWORDS = [
  /\bopen\b/i,
  /\bprep\b/i,
  /\breview\b/i,
  /\bdraft\b/i,
  /\bread\b/i,
  /\bcheck\b/i,
];

interface TaskCtx {
  description?: string | null;
  estimatedDurationMinutes?: number | null;
  goalTitle?: string | null;
  priority?: string | null;
  scheduledStart?: string | null;
}

function formatDuration(mins?: number | null): string | null {
  if (!mins) return null;
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

function extractPrepHint(description?: string | null): string | null {
  if (!description) return null;
  const trimmed = description.trim();
  if (!trimmed) return null;

  // Prefer a URL if present
  const url = trimmed.match(URL_RE);
  if (url) return `Open ${url[0]}`;

  // Repo-like token (owner/repo)
  const repo = trimmed.match(REPO_RE);
  if (repo) return `Open ${repo[1]}`;

  // First line / sentence, capped
  const firstLine = trimmed.split(/\n|\. /)[0]?.trim();
  if (!firstLine) return null;
  const capped = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;

  // If the line already reads like a prep instruction, surface it as-is
  if (PREP_KEYWORDS.some((re) => re.test(capped))) return capped;
  return `Prep: ${capped}`;
}

export function buildTaskReminderBody(title: string, ctx: TaskCtx = {}): string {
  const parts: string[] = [];

  const prep = extractPrepHint(ctx.description);
  if (prep) parts.push(prep);

  if (ctx.goalTitle) parts.push(`Goal: ${ctx.goalTitle}`);

  const dur = formatDuration(ctx.estimatedDurationMinutes);
  if (dur) parts.push(dur);

  if (ctx.priority === 'high') parts.push('High priority');

  if (parts.length === 0) return title;
  return `${title} — ${parts.join(' · ')}`;
}

export function taskToContext(task: Task): TaskCtx {
  const t = task as any;
  return {
    description: t.description,
    estimatedDurationMinutes: t.estimatedDurationMinutes ?? t.estimated_duration_minutes,
    goalTitle:
      t.weeklyGoal?.title ??
      t.goal?.title ??
      t.linkedGoal?.title ??
      null,
    priority: t.priority,
    scheduledStart: t.scheduledStart ?? t.scheduled_start,
  };
}
