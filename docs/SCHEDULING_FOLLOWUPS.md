# Scheduling — Pre-existing bugs & follow-ups

Discovered during the 2026-05-07 fix of the today/weekly/calendar drift
(commit `2f182aa`, "fixing calendar i hope"). None of these block the user
right now, but each is a real bug or a sharp edge worth fixing in its own PR.

---

## 1. `processRecurringTasks` uses UTC weekday for non-UTC users  ✅ FIXED 2026-05-07

**File:** `apps/api/src/services/tasks.service.ts` lines ~580–622

**What's wrong**

```ts
const today = startOfLocalDayUtc(new Date(), tz)
const todayDay = today.getUTCDay()              // ← uses UTC weekday
// ...
shouldGenerate = todayDay === parentDay         // weekly rule
shouldGenerate = todayDay >= 1 && todayDay <= 5 // weekdays rule
```

For a Tokyo user (UTC+9) at "today" Tokyo May 7 (Thursday), `today` is
`2026-05-06T15:00:00Z`. `getUTCDay()` returns Wednesday (3) — wrong day.
Same problem for `getUTCDate()` near month boundaries. Recurring instances
either fail to generate on the right day or generate on the wrong day.

**Fix**

Use `localDayOfWeek(now, tz)` (already exported from `@repo/shared/utils`)
for weekday math, and `localYmd(now, tz)` for the day-of-month. Don't
derive weekday/day-of-month from a UTC instant.

```ts
import { localDayOfWeek, localYmd } from '@repo/shared/utils'
const todayDay = localDayOfWeek(new Date(), tz)
const todayDom = Number(localYmd(new Date(), tz).slice(8, 10))
```

The `parentDay` comparison should also be derived in the parent task's
intent timezone (today the parent's `scheduledDate` UTC components are
read directly — fine after the 2026-05-07 normalization migration since
all `scheduledDate` values are now UTC-midnight of the local Y-M-D).

**Test**

Unit test: parent recurring task with `recurrenceRule='weekly'` and the
parent's `scheduledDate` being a Thursday in Lima → call `processRecurringTasks`
for a Tokyo user mocked to "now = Thursday morning Tokyo (= Wednesday
evening UTC)". Should generate. Today it doesn't.

**Resolution**

Fixed during the tasks-recurring extraction. The new
`apps/api/src/services/tasks/tasks-recurring.service.ts` derives weekday
via `localDayOfWeek(now, tz)` and day-of-month by parsing
`localYmd(now, tz)`, both anchored on the user's timezone. Same fix
applied to the `parent.scheduledDate` reads in the weekly/monthly
branches.

---

## 2. `generateTimeBlocks` filters `scheduledDate` against working-hours window

**File:** `apps/api/src/services/calendar.service.ts` lines ~1119–1126

**What's wrong**

```ts
const candidateTasks = allOpenTasks.filter((t: any) => {
  const scheduled = t.scheduledDate ? new Date(t.scheduledDate) : null
  const due = t.dueDate ? new Date(t.dueDate) : null
  if (scheduled && scheduled >= dayStart && scheduled <= dayEnd) return true
  // ...
})
```

`dayStart`/`dayEnd` here come from `getDayWindow()` — that's the user's
**working-hours** window (e.g. 09:00–17:00 in their TZ), not the full day.
But `scheduledDate` is a calendar-date marker, stored at UTC-midnight after
the 2026-05-07 migration. UTC-midnight is never inside any reasonable
working-hours window, so the filter always evaluates false on dated tasks.
The function silently degrades to "candidates = backlog only".

**Fix**

Compare `scheduledDate` against the local **calendar day** of the requested
date, not the working-hours window. Either build a separate
`[localDayStart, localDayEnd]` range, or simpler, since `scheduledDate` is
now always UTC-midnight of the local Y-M-D:

```ts
const ymd = (typeof date === 'string' ? date : localYmd(date, tz)).slice(0, 10)
const dayDateStart = new Date(`${ymd}T00:00:00.000Z`)
const dayDateEnd = new Date(`${ymd}T23:59:59.999Z`)
// ...
if (scheduled && scheduled >= dayDateStart && scheduled <= dayDateEnd) return true
```

**Test**

Create a task with `scheduledDate=YYYY-MM-DDT00:00:00Z` for the test user,
no working session, then call `generateTimeBlocks(userId, 'YYYY-MM-DD')`.
The task should appear in `candidateTasks`. Today it doesn't.

---

## 3. GHA deploy reports success when `compose pull` silently fails  ✅ FIXED 2026-05-07

**File:** `.github/workflows/deploy.yml` (step "Pull latest images and start containers")

**What's wrong**

When `~/.docker/config.json` on the server has a stale GHCR PAT (which it
did on 2026-05-07), `docker compose pull` errors per-image with
`error from registry: denied` but exits 0 overall. The subsequent
`docker compose up -d` finds no image change and leaves the API container
running the old code. Health checks pass (because the old API is fine),
the workflow marks "success", and the deploy is invisibly stale.

**Fix (any one is enough; doing both is belt-and-suspenders)**

a. Force-overwrite the credential cache before pulling:

```yaml
- name: Authenticate to GHCR
  run: ssh ${{ env.SSH_TARGET }} 'docker logout ghcr.io || true && echo "${{ secrets.GHCR_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin'
```

b. Capture the pre/post image digest of the API container and fail the
   step if it didn't change after `up -d` when a new commit was pushed:

```yaml
- name: Verify API was updated
  run: |
    BEFORE=$(ssh ... 'docker inspect theprimeway-api-1 --format "{{.Image}}"')
    ssh ... 'cd /var/www/theprimeway && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d'
    AFTER=$(ssh ... 'docker inspect theprimeway-api-1 --format "{{.Image}}"')
    if [ "$BEFORE" = "$AFTER" ] && [ "${{ github.event.head_commit.message }}" != *"[skip-deploy]"* ]; then
      echo "::error::API container image unchanged after pull. Aborting."
      exit 1
    fi
```

**Test**

Manually expire the PAT on the server, push a code change, and confirm the
workflow now fails the deploy step instead of falsely succeeding.

**Resolution**

`.github/workflows/deploy.yml` "Pull latest images and start containers" step
now does `docker login ghcr.io` with the workflow's own `GITHUB_TOKEN` before
pull, and the `|| true` after pull was removed. A pull failure now fails the
deploy loudly instead of silently retaining the old container.

---

## 4. Migration script not in production image (minor)

**File:** `apps/api/Dockerfile` (or whatever step copies sources)

`apps/api/scripts/normalize-scheduled-dates.ts` was committed but isn't
copied into the production image, so on 2026-05-07 the migration was run
by `docker cp`-ing an inline `.mjs` instead. Not urgent — but if we expect
to ship more one-shot reconcile scripts, copy `apps/api/scripts/` into the
image and document the `docker exec ... node scripts/<name>.js` pattern.

The reconcile script `apps/api/scripts/reconcile-task-mirrors.ts` (added
in the unify commit) has a different bug worth fixing while we're here:
it queries `where: { sessions: { some: {} } }` but the relation in the
Prisma schema is named `workingSessions`, not `sessions`. The script
would error on first run if anyone tried it.

---

## Out of scope here (separate decision)

**UX: tasks without sessions don't show on the calendar grid.** The
unify-scheduling-truth commit removed the legacy fallback that pinned
unscheduled-but-dated tasks onto the calendar. As a consequence, a user
who creates 5 tasks for "today" with no time slot sees 5 entries in the
left list of `/tasks/today` but an empty grid on the right (and an empty
`/calendar` page). This is by design, not a bug — but the user expectation
is that tasks should appear somewhere on the calendar. Two options if we
want to address it:

1. Re-introduce a fallback: render dated tasks without sessions as
   all-day chips at the top of the day column.
2. Change the create flow so every "today" task that lacks an explicit
   time auto-schedules into the next free gap (the `autoSchedule: true`
   path already exists; it'd become the default for `bucket=TODAY`).

Pick whichever matches the product intent.
