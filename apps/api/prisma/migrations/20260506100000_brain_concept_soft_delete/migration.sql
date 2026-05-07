-- Soft-delete support for BrainConcept. When an entry is deleted, concepts
-- whose only occurrences were in that entry get marked deleted_at instead of
-- being physically removed — preserves embeddings + history so re-extraction
-- can revive the same row.
ALTER TABLE "brain_concepts" ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE INDEX "brain_concepts_user_id_deleted_at_idx" ON "brain_concepts"("user_id", "deleted_at");
