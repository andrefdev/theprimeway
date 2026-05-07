/**
 * One-shot cleanup for legacy data created before the BrainConcept soft-delete
 * feature landed. Two passes, idempotent — safe to re-run:
 *
 *   1. Delete BrainConceptOccurrence rows whose entry was already soft-deleted.
 *      Edges are not touched here; reads filter alive↔alive.
 *   2. Mark BrainConcept.deletedAt for any concept that ends up with zero
 *      remaining occurrences (and isn't already merged or soft-deleted).
 *
 * Usage:
 *   pnpm --filter @repo/api exec tsx scripts/cleanup-orphan-concepts.ts
 *   pnpm --filter @repo/api exec tsx scripts/cleanup-orphan-concepts.ts --dry-run
 */
import 'dotenv/config'
import { prisma } from '../src/lib/prisma'

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
  console.log(`[cleanup-orphan-concepts] starting${DRY_RUN ? ' (dry-run)' : ''}`)

  // Pass 1 — drop occurrences whose entry is soft-deleted.
  const orphanedOccurrences = await prisma.brainConceptOccurrence.findMany({
    where: { entry: { deletedAt: { not: null } } },
    select: { id: true, conceptId: true },
  })
  console.log(`[pass 1] found ${orphanedOccurrences.length} occurrences tied to deleted entries`)

  let deletedOccurrences = 0
  if (orphanedOccurrences.length > 0 && !DRY_RUN) {
    const r = await prisma.brainConceptOccurrence.deleteMany({
      where: { id: { in: orphanedOccurrences.map((o) => o.id) } },
    })
    deletedOccurrences = r.count
    console.log(`[pass 1] deleted ${deletedOccurrences} occurrences`)
  }

  // Pass 2 — soft-delete concepts that now have zero live occurrences.
  // Pulls candidates that aren't already soft-deleted or merged. We compute
  // remaining occurrence counts in JS to keep the script Prisma-only.
  const candidates = await prisma.brainConcept.findMany({
    where: { deletedAt: null, mergedIntoId: null },
    select: { id: true, userId: true, name: true, _count: { select: { occurrences: true } } },
  })
  const orphanConceptIds = candidates
    .filter((c) => c._count.occurrences === 0)
    .map((c) => ({ id: c.id, userId: c.userId, name: c.name }))
  console.log(`[pass 2] found ${orphanConceptIds.length} concepts with zero remaining occurrences`)

  let softDeletedConcepts = 0
  if (orphanConceptIds.length > 0 && !DRY_RUN) {
    const r = await prisma.brainConcept.updateMany({
      where: { id: { in: orphanConceptIds.map((c) => c.id) } },
      data: { deletedAt: new Date() },
    })
    softDeletedConcepts = r.count
    console.log(`[pass 2] soft-deleted ${softDeletedConcepts} concepts`)
  }

  console.log(
    `[cleanup-orphan-concepts] done${DRY_RUN ? ' (dry-run, nothing written)' : ''} — occurrences: ${deletedOccurrences}, concepts: ${softDeletedConcepts}`,
  )

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
