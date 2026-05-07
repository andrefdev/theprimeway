-- Persist additional Google Calendar event fields previously fetched live but
-- lost after migrating from cache-mode to DB-backed CalendarEvent. The new
-- columns are all nullable / default so existing rows remain valid; they are
-- repopulated on the next webhook upsert or manual /calendar/sync.
ALTER TABLE "calendar_events" ADD COLUMN "description" TEXT;
ALTER TABLE "calendar_events" ADD COLUMN "location" TEXT;
ALTER TABLE "calendar_events" ADD COLUMN "html_link" TEXT;
ALTER TABLE "calendar_events" ADD COLUMN "hangout_link" TEXT;
ALTER TABLE "calendar_events" ADD COLUMN "visibility" TEXT;
ALTER TABLE "calendar_events" ADD COLUMN "recurring_event_id" TEXT;
ALTER TABLE "calendar_events" ADD COLUMN "recurrence" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "calendar_events" ADD COLUMN "attendees" JSONB;
ALTER TABLE "calendar_events" ADD COLUMN "organizer" JSONB;
