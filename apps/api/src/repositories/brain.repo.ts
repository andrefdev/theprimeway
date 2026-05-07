import { prisma } from '../lib/prisma'
import type { Prisma } from '@prisma/client'

export interface BrainEntryCreate {
  sourceType?: string
  sourceDevice?: string
  rawTranscript: string
  language?: string
}

export interface BrainEntryPipelinePatch {
  status?: string
  title?: string | null
  summary?: string | null
  topics?: unknown
  sentiment?: string | null
  actionItems?: unknown
  aiMetadata?: unknown
  errorMessage?: string | null
  processedAt?: Date | null
}

export interface BrainEntryUserPatch {
  userTitle?: string | null
  topics?: unknown
  isPinned?: boolean
  isArchived?: boolean
}

export interface CrossLinkInput {
  targetType: 'task' | 'goal' | 'habit'
  targetId: string
  linkType: 'related' | 'spawned_from' | 'action_for' | 'evidence_for'
  aiGenerated?: boolean
}

class BrainRepository {
  findMany(
    userId: string,
    opts: { status?: string; search?: string; limit?: number; offset?: number } = {},
  ) {
    const where: any = { userId, deletedAt: null }
    if (opts.status) where.status = opts.status
    if (opts.search) {
      where.OR = [
        { title: { contains: opts.search, mode: 'insensitive' } },
        { rawTranscript: { contains: opts.search, mode: 'insensitive' } },
      ]
    }
    return prisma.brainEntry.findMany({
      where,
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      take: opts.limit ?? 50,
      skip: opts.offset ?? 0,
    })
  }

  findById(id: string, userId: string) {
    return prisma.brainEntry.findFirst({
      where: { id, userId, deletedAt: null },
      include: { crossLinks: true },
    })
  }

  create(userId: string, data: BrainEntryCreate) {
    return prisma.brainEntry.create({
      data: {
        userId,
        sourceType: data.sourceType ?? 'text',
        sourceDevice: data.sourceDevice,
        rawTranscript: data.rawTranscript,
        language: data.language ?? 'en',
        status: 'pending',
      },
    })
  }

  updatePipeline(id: string, patch: BrainEntryPipelinePatch) {
    return prisma.brainEntry.update({
      where: { id },
      data: {
        ...patch,
        topics: patch.topics as Prisma.InputJsonValue | undefined,
        actionItems: patch.actionItems as Prisma.InputJsonValue | undefined,
        aiMetadata: patch.aiMetadata as Prisma.InputJsonValue | undefined,
      },
    })
  }

  async updateUser(id: string, userId: string, patch: BrainEntryUserPatch) {
    const r = await prisma.brainEntry.updateMany({
      where: { id, userId, deletedAt: null },
      data: {
        ...patch,
        topics: patch.topics as Prisma.InputJsonValue | undefined,
      },
    })
    if (r.count === 0) return null
    return prisma.brainEntry.findUnique({ where: { id } })
  }

  async softDelete(id: string, userId: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const r = await tx.brainEntry.updateMany({
        where: { id, userId, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (r.count === 0) return false
      await this.cleanupEntryConcepts(tx, id, userId)
      return true
    })
  }

  async resetToPending(id: string, userId: string) {
    return prisma.$transaction(async (tx) => {
      const r = await tx.brainEntry.updateMany({
        where: { id, userId, deletedAt: null },
        data: {
          status: 'pending',
          errorMessage: null,
          processedAt: null,
        },
      })
      if (r.count === 0) return null
      // Drop occurrences from the previous extraction so the upcoming pipeline
      // run starts clean. Concepts whose only mention was in this entry get
      // soft-deleted now and will revive automatically if the new extraction
      // picks them up again (resolveConcepts handles revival by exact name).
      await this.cleanupEntryConcepts(tx, id, userId)
      return tx.brainEntry.findUnique({ where: { id } })
    })
  }

  /**
   * Drop all BrainConceptOccurrence rows for `entryId` and reconcile the
   * affected concepts: orphans (no remaining occurrences) get soft-deleted,
   * survivors get `mentionCount` decremented. Edges are not touched; reads
   * filter to alive↔alive endpoints. Pure helper, expects to run inside an
   * existing transaction.
   */
  private async cleanupEntryConcepts(
    tx: Prisma.TransactionClient,
    entryId: string,
    userId: string,
  ): Promise<void> {
    const occurrences = await tx.brainConceptOccurrence.findMany({
      where: { entryId },
      select: { conceptId: true },
    })
    if (occurrences.length === 0) return

    const affectedConceptIds = Array.from(new Set(occurrences.map((o) => o.conceptId)))
    await tx.brainConceptOccurrence.deleteMany({ where: { entryId } })

    const survivors = await tx.brainConceptOccurrence.groupBy({
      by: ['conceptId'],
      where: { conceptId: { in: affectedConceptIds } },
    })
    const survivingIds = new Set(survivors.map((s) => s.conceptId))
    const orphanedIds = affectedConceptIds.filter((cid) => !survivingIds.has(cid))

    if (orphanedIds.length > 0) {
      await tx.brainConcept.updateMany({
        where: { id: { in: orphanedIds }, userId },
        data: { deletedAt: new Date() },
      })
    }
    if (survivingIds.size > 0) {
      await tx.brainConcept.updateMany({
        where: { id: { in: Array.from(survivingIds) }, userId },
        data: { mentionCount: { decrement: 1 } },
      })
    }
  }

  createCrossLinks(entryId: string, userId: string, links: CrossLinkInput[]) {
    if (links.length === 0) return Promise.resolve({ count: 0 })
    return prisma.brainCrossLink.createMany({
      data: links.map((l) => ({
        entryId,
        userId,
        targetType: l.targetType,
        targetId: l.targetId,
        linkType: l.linkType,
        aiGenerated: l.aiGenerated ?? true,
      })),
      skipDuplicates: true,
    })
  }

  deleteCrossLinks(entryId: string) {
    return prisma.brainCrossLink.deleteMany({ where: { entryId } })
  }
}

export const brainRepo = new BrainRepository()
