# Scheduling — Pending work

Living plan for the remaining refactor phases and product corrections. Items
move out of this doc into commit history once shipped. Resolved items from
prior versions of this file are recorded in git rather than here.

---

## Refactor — phase 7b: split calendar Group C

The last lump in `apps/api/src/services/calendar.service.ts` — six methods
that aren't really about Google Calendar's *transport* layer (those moved
to `services/calendar/` already) but about *scheduling math* on top of the
calendar data. They belong under `services/scheduling/` since they use the
gap-finder and the same TZ utilities the rest of the scheduler uses.

Splits into two coherent modules:

### 7b.1 — `services/scheduling/free-slots.service.ts`

Pure analytics over the user's calendar — no mutation, no AI.

| Function | Source line in calendar.service.ts (HEAD) | Notes |
|---|---|---|
| `getFreeSlots(userId, date, duration)` | ~261 | Returns gaps ≥ `duration` min on `date` |
| `analyzeFreeTime(userId, start, end)` | ~294 | Multi-day free/busy summary, walks one local day at a time |

**Dependencies:** `gap-finder` (`getDayWindow`, `collectBusyBlocks`,
`computeGaps`), `@repo/shared/utils` for tz/local-day helpers, `prisma` for
`UserSettings.timezone` + `WorkingHours`.

**Callers to update** (4 sites):
- `apps/api/src/lib/ai-tools/calendar.tools.ts:40` — `findFreeSlots` AI tool
- `apps/api/src/routes/calendar.ts:196` — `GET /free-time`
- `apps/api/src/routes/calendar.ts:795` — legacy free-slots route
- `apps/api/src/services/chat.service.ts:288` — chat AI's calendar context
- `apps/api/src/services/tasks.service.ts:620` — `tasksService.scheduleTask`
  (the duration-suggestion one) — only switch this caller AFTER #8 because
  that whole method moves out at the same time

**Risk:** low. Pure aggregation, no AI prompts to preserve.

### 7b.2 — `services/scheduling/time-block.service.ts`

AI-assisted block creation. These build Google events (or local "time
blocks") from tasks/habits using the gap-finder + an LLM call to pick
slots.

| Function | Source line | Notes |
|---|---|---|
| `createTimeBlock(userId, input)` | ~383 | Create one Google event from a task spec |
| `createHabitBlock(userId, input)` | ~525 | Same idea for a habit (recurring pattern) |
| `generateTimeBlocks(userId, date)` | ~639 | LLM picks slots for N candidate tasks at once |
| `findSmartSlots(userId, taskId, date)` | ~736 | LLM-ranked top slots for a single task |

**Dependencies:** gap-finder, `tasksRepository` (read open tasks for
candidates), `ai-models` (`taskModel`), `calendarRepo`,
`upsertCalendarEventCache` (write-through after creating the Google event),
`google-token.service` for `ensureAccessToken`, `google-events-sync.service`
(`syncCalendars` triggered after habit-block creation to expand recurrence).

**Callers to update** (3 sites):
- `apps/api/src/routes/calendar.ts:254` — `GET /ai/time-blocks`
- `apps/api/src/routes/calendar.ts:315` — `POST /tasks/:id/smart-slots`
- `apps/api/src/routes/calendar.ts:586` — `POST /time-block`
- `apps/api/src/routes/calendar.ts:738` — `POST /habit-block`

**Risk:** medium. The LLM prompts are long and any whitespace shift can
change the model's output subtly. **Don't reformat them** during the move
— copy verbatim. Each method's `generateObject(...)` call has a `prompt`
arg with embedded ISO timestamps and gap descriptions; it's load-bearing.

**Bug to fix in passing** (lifted from previous followups #2): the
candidate-task filter in `generateTimeBlocks` compares `scheduledDate`
against the working-hours window:

```ts
if (scheduled && scheduled >= dayStart && scheduled <= dayEnd) return true
```

`dayStart`/`dayEnd` here come from `getDayWindow()` — the **working-hours**
range (e.g. 09:00–17:00 in user's tz), not the calendar day. Since
`scheduledDate` is now stored at UTC-midnight (post the 2026-05-07
normalization), every dated task fails this filter and the function silently
degrades to "candidates = backlog only". Fix while extracting:

```ts
const ymd = (typeof date === 'string' ? date : localYmd(date, tz)).slice(0, 10)
const dayDateStart = new Date(`${ymd}T00:00:00.000Z`)
const dayDateEnd = new Date(`${ymd}T23:59:59.999Z`)
// ...
if (scheduled && scheduled >= dayDateStart && scheduled <= dayDateEnd) return true
```

**Test plan:** create a task with `scheduledDate=YYYY-MM-DDT00:00:00Z` and
no working session, then call `generateTimeBlocks(userId, 'YYYY-MM-DD')` —
the task should appear in `candidateTasks` and the LLM should slot it.
Today it doesn't.

### After 7b

`calendar.service.ts` should be **empty** (or just a re-export shim that
keeps `import { calendarService } from '../services/calendar.service'`
working until every caller is updated). Delete the file once nothing
imports it.

---

## Refactor — phase 8: extract tasks AI

Module: `services/tasks/tasks-ai.service.ts`. Depends on 7b.1 (uses
`getFreeSlots`).

| Function | Source line in tasks.service.ts (HEAD) | Notes |
|---|---|---|
| `getScheduleSuggestion(userId, date, duration, preferred?)` | ~480 | Gap-finder picks; not actually AI but lives in the AI cluster |
| `suggestTimebox(userId, taskId)` | ~575 | LLM estimates duration from completion history |
| `estimateTimebox(userId, title, description?, taskId?)` | ~625 | LLM estimates from title alone (used during create) |
| `scheduleTask(userId, taskId, duration?)` | ~660 | Calls `getFreeSlots` to suggest a slot |
| `suggestNextTask(userId)` | ~692 | LLM picks "what should I do next" |
| `detectScheduleConflicts(userId, date)` | ~755 | Compares task schedule vs Google events |

**Dependencies:** `tasksRepository`, `ai-models` (taskModel + fastModel),
new `free-slots.service` (from 7b.1), `google-events-sync.service`
(`getGoogleEvents` for `detectScheduleConflicts`), `gap-finder` for
busy-block context.

**Callers to update** (~5 sites in routes/tasks.ts and ai-tools/).

**Risk:** medium. Same LLM prompt-preservation rule applies.

---

## Refactor — phase 10: tasks CRUD final shape

After phases 5, 6, 8, 9 land, `tasks.service.ts` only contains:

- `listTasks` / `getGroupedTasks` / `getTask`
- `createTask` / `updateTask` / `deleteTask`
- `startTaskTimer` / `stopTaskTimer`
- `autoArchiveCompleted`

That's a coherent CRUD module — it can stay in the original file. Two
options:

**Option A** — leave it as `tasks.service.ts`. Simpler; no caller
churn. The file becomes ~400 lines, focused on CRUD, which is the right
shape for the "main" service of the domain.

**Option B** — rename to `tasks/tasks-crud.service.ts` for symmetry with
the sibling modules (stats, views, recurring, ai). Updates ~30 import
sites; mostly mechanical.

Recommendation: **A**. The folder structure tells the story already
(`tasks/` for the satellites, `tasks.service.ts` as the core), and the
name is the natural one consumers expect.

---

## Product correction — default channel on task create

**The gap.** A task without a `channelId` lives outside any context
("personal", "work", whatever the user has set up). Several downstream
behaviors get worse for nullable-channel tasks:

- Channel-specific working hours (`WorkingHours.channelId`) don't apply,
  so gap-finder uses the user-default hours even when the task should
  belong to a channel with different hours.
- Channel → calendar push (`Channel.timeboxToCalendarId`) is bypassed,
  so the task's session lands on the account's default Google calendar
  even when the user configured per-channel routing.
- The Today/Weekly UI shows a colour dot per channel; channel-less tasks
  render with no colour cue.

**The fix.** When `tasksService.createTask` runs without an explicit
`channelId`, fall back to the user's default channel — `Channel.isDefault
= true` already exists in the schema (`apps/api/prisma/schema.prisma`
line 947). If the user has no default channel set, bootstrap one
("Personal", `isDefault=true`, default colour) on first task create so
every user always has at least one.

**Where to change:**

1. `apps/api/src/services/tasks.service.ts` `createTask`: after the
   `data` object is built, if `data.channelId` is undefined or null,
   resolve and assign:

   ```ts
   if (!data.channelId) {
     const def = await prisma.channel.findFirst({
       where: { userId, isDefault: true, isEnabled: true },
     })
     if (def) {
       data.channelId = def.id
     } else {
       // Bootstrap on first create — single Channel row marked default.
       const created = await prisma.channel.create({
         data: {
           userId,
           contextId: /* see note below */,
           name: 'Personal',
           isDefault: true,
         },
       })
       data.channelId = created.id
     }
   }
   ```

   Note: `Channel.contextId` is required. The user's first `Context` row
   needs to exist (or be created) before the channel — check if the user
   has any context, create a default one if not. There's a pre-existing
   onboarding flow that does this; reuse it instead of duplicating.

2. **Frontend** (`apps/web/src/features/tasks/hooks/use-task-form.ts`):
   the form already has a `channelId` field. The default-channel resolution
   above happens server-side, so the form doesn't need to know — but if
   the UI wants to *display* the resolved channel before submit, it
   should fetch `/api/channels?default=true` and pre-populate the picker.
   That's a polish item, not load-bearing.

3. **Mobile** (same shape — server takes care of it).

**Migration for existing data:** any open tasks with `channelId=null` get
patched to the user's default channel via a one-shot script. Same skeleton
as `apps/api/scripts/normalize-scheduled-dates.ts`. Bootstrap the
default channel for users who have none before patching.

**Test plan:**

- New user, first task — channel is auto-created and assigned.
- Existing user with one channel marked `isDefault=true` — task picks it
  up without explicit `channelId`.
- Existing user with multiple channels, none `isDefault` — script
  normalisation picks the first one alphabetically and marks it default.
- Task created with `channelId` explicit — no override, the explicit
  value wins.

---

## Out of scope here (decisions deferred)

### UX: tasks without WorkingSession don't appear on the calendar grid

Post the unify-scheduling-truth commit, the calendar grid only renders
items that have a `WorkingSession`. A user who creates 5 dated tasks
with no time slot sees 5 entries in `/tasks/today`'s left list but an
empty grid on the right (and `/calendar` is similarly empty). The
default-on auto-schedule fix in `tasksService.createTask` (already
shipped) closes the common case — every new dated task auto-schedules
into a session — but legacy data created before that fix still has the
gap.

Two product directions if we want to address it:

1. **Render dated-without-session as all-day chips** at the top of each
   day column. Cosmetic only; doesn't change session model.
2. **Backfill sessions** for legacy dated tasks via a one-shot
   `auto-schedule` pass per user. Mutates data; takes the user's
   working-hours into account.

Pick one when product decides; don't ship both.

### Migration script not in the production image

`apps/api/scripts/*.ts` are committed but `apps/api/Dockerfile` doesn't
copy them into the image. The 2026-05-07 normalize script ran via
`docker cp` of an inline `.mjs` instead. Low priority — only matters
when we ship the next reconcile script. Quick fix: `COPY scripts ./scripts`
in the Dockerfile, document the `docker exec ... node scripts/<name>.js`
pattern.

The reconcile script `apps/api/scripts/reconcile-task-mirrors.ts` (added
in the unify commit) has a typo: queries `where: { sessions: { some: {} } }`
but the relation in the Prisma schema is named `workingSessions`. Would
error on first run if anyone tried it. Drive-by fix when we touch the
scripts dir.

---

## Conventions for these refactors

1. **One commit per phase**, atomic. So each phase can be reverted
   independently if a regression surfaces.
2. **No functional changes mixed with extractions**, except clearly
   marked drive-by bug fixes (e.g. the TZ bug in #9 was a one-liner that
   became obvious in isolation; calling it out in the commit message).
3. **Typecheck verde after each commit.** Run `npm run typecheck` in
   `apps/api` (and `apps/web` if any frontend touched).
4. **Public method shapes unchanged.** Only the import path changes.
   This keeps the blast radius bounded to "where do I import from?"
   rather than "did the contract change?".
5. **No re-export shims unless strictly needed.** The previous policy
   ("keep `calendarService.X` as a thin facade") accumulated dust; the
   chosen pattern is direct imports of the new module functions, with
   the calling file's import block updated in the same commit.
