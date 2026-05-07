/**
 * Brain Graph repository — raw SQL access for the concept graph.
 *
 * Prisma 7 does not support pgvector natively, so anything that reads or
 * writes the `vector(1536)` column lives here as `prisma.$queryRaw` /
 * `prisma.$executeRaw`. Everything else goes through the regular Prisma
 * client.
 */
import { prisma } from '../lib/prisma'
import { toPgVector } from '../lib/embeddings'

export interface ConceptCandidate {
  name: string
  normalizedName: string
  kind: string
  embedding: number[]
  salience: number
  quote?: string
}

export interface CatalogConcept {
  id: string
  name: string
  normalizedName: string
  kind: string
  centralityScore: number
  mentionCount: number
  lastMentionedAt: Date
}

export interface ResolvedConcept {
  /** ID of the concept this candidate maps to (existing or newly inserted). */
  id: string
  /** True if a new row was created; false if we matched/reused an existing concept. */
  inserted: boolean
  /** Cosine similarity (1 - distance) to the matched concept, only set when matched. */
  similarity?: number
}

class BrainGraphRepository {
  // ─── Catalog (used to seed the prefix-cached prompt) ───────────────────

  /**
   * Top-N concepts by centrality + recency. Used as the "user concept catalog"
   * header in the extraction prompt so DeepSeek's prefix cache can hit. Bucket
   * by week so within a week the catalog is stable.
   */
  async getCatalog(userId: string, limit = 80): Promise<CatalogConcept[]> {
    const rows = await prisma.brainConcept.findMany({
      where: { userId, mergedIntoId: null, deletedAt: null },
      select: {
        id: true,
        name: true,
        normalizedName: true,
        kind: true,
        centralityScore: true,
        mentionCount: true,
        lastMentionedAt: true,
      },
      orderBy: [{ centralityScore: 'desc' }, { lastMentionedAt: 'desc' }],
      take: limit,
    })
    return rows
  }

  // ─── Concept upsert with vector dedupe ─────────────────────────────────

  /**
   * For each candidate, find the nearest existing concept via cosine distance.
   * If similarity > threshold, reuse it; otherwise insert a new concept.
   * Returns one ResolvedConcept per candidate, in input order.
   *
   * threshold default 0.85 means cosine distance < 0.15 — tight enough to
   * avoid false merges (tested on text-embedding-3-small).
   */
  async resolveConcepts(
    userId: string,
    candidates: ConceptCandidate[],
    threshold = 0.85,
  ): Promise<ResolvedConcept[]> {
    if (candidates.length === 0) return []

    const results: ResolvedConcept[] = []

    for (const candidate of candidates) {
      const vec = toPgVector(candidate.embedding)

      // Try the unique-name fast path first (pre-computed normalization). If
      // the row exists but was soft-deleted (entry that birthed it was deleted),
      // revive it: clear deletedAt, reset mentionCount=1, refresh timestamp.
      // Re-uses the original embedding + history.
      const exact = await prisma.brainConcept.findUnique({
        where: { userId_normalizedName: { userId, normalizedName: candidate.normalizedName } },
        select: { id: true, deletedAt: true },
      })
      if (exact) {
        if (exact.deletedAt) {
          await prisma.brainConcept.update({
            where: { id: exact.id },
            data: { deletedAt: null, mentionCount: 1, lastMentionedAt: new Date() },
          })
        } else {
          await this.bumpMention(exact.id)
        }
        results.push({ id: exact.id, inserted: false, similarity: 1 })
        continue
      }

      // Vector similarity search via the HNSW index (cosine ops). Filter out
      // soft-deleted concepts so a fuzzy match doesn't silently revive a
      // semantically-similar-but-different concept the user no longer wants.
      // Only the exact normalized-name path above can revive.
      const nearest = await prisma.$queryRaw<Array<{ id: string; sim: number }>>`
        SELECT
          id,
          1 - (embedding <=> ${vec}::vector) AS sim
        FROM brain_concepts
        WHERE user_id = ${userId}
          AND merged_into_id IS NULL
          AND deleted_at IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vec}::vector
        LIMIT 1
      `

      const top = nearest[0]
      if (top && top.sim >= threshold) {
        await this.bumpMention(top.id)
        results.push({ id: top.id, inserted: false, similarity: top.sim })
        continue
      }

      // No match — insert a new concept with the embedding.
      const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO brain_concepts (
          id, user_id, name, normalized_name, kind, embedding,
          mention_count, last_mentioned_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid()::text,
          ${userId},
          ${candidate.name},
          ${candidate.normalizedName},
          ${candidate.kind},
          ${vec}::vector,
          1,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT (user_id, normalized_name) DO UPDATE
          SET mention_count = brain_concepts.mention_count + 1,
              last_mentioned_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `
      results.push({ id: inserted[0]!.id, inserted: true })
    }

    return results
  }

  private async bumpMention(conceptId: string) {
    await prisma.brainConcept.update({
      where: { id: conceptId },
      data: {
        mentionCount: { increment: 1 },
        lastMentionedAt: new Date(),
      },
    })
  }

  // ─── Occurrences ────────────────────────────────────────────────────────

  async upsertOccurrences(
    rows: Array<{ conceptId: string; entryId: string; salience: number; quote?: string }>,
  ): Promise<void> {
    if (rows.length === 0) return
    await prisma.$transaction(
      rows.map((r) =>
        prisma.brainConceptOccurrence.upsert({
          where: { conceptId_entryId: { conceptId: r.conceptId, entryId: r.entryId } },
          create: {
            conceptId: r.conceptId,
            entryId: r.entryId,
            salience: r.salience,
            quote: r.quote ?? null,
          },
          update: { salience: r.salience, quote: r.quote ?? null },
        }),
      ),
    )
  }

  // ─── Edges (Hebbian: weight = mentionCount * exp(-days / 30)) ──────────

  async reinforceEdges(
    userId: string,
    pairs: Array<[string, string]>,
    relationType = 'co_mentioned',
  ): Promise<void> {
    if (pairs.length === 0) return

    // Normalize ordering so (a,b) and (b,a) collapse for symmetric relations.
    const isSymmetric = relationType === 'co_mentioned' || relationType === 'related_to'

    const rows = pairs
      .map(([a, b]) => {
        if (a === b) return null
        const [src, tgt] = isSymmetric && a > b ? [b, a] : [a, b]
        return { src, tgt }
      })
      .filter((x): x is { src: string; tgt: string } => x !== null)

    if (rows.length === 0) return

    // Per-pair upsert in a single transaction. Edges per entry max out around
    // C(10,2)=45 — well within transaction budget. The Hebbian decay formula
    // recomputes weight on every reinforcement using the gap since the last
    // touch. ON CONFLICT lets a single round-trip handle insert vs update.
    await prisma.$transaction(
      rows.map(
        ({ src, tgt }) =>
          prisma.$executeRaw`
            INSERT INTO brain_concept_edges (
              id, user_id, source_concept_id, target_concept_id,
              relation_type, weight, mention_count, last_reinforced_at, created_at
            ) VALUES (
              gen_random_uuid()::text,
              ${userId},
              ${src},
              ${tgt},
              ${relationType},
              1,
              1,
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
            ON CONFLICT (source_concept_id, target_concept_id, relation_type) DO UPDATE
              SET mention_count = brain_concept_edges.mention_count + 1,
                  last_reinforced_at = CURRENT_TIMESTAMP,
                  weight = (brain_concept_edges.mention_count + 1)
                           * exp(-EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - brain_concept_edges.last_reinforced_at)) / (60.0 * 60.0 * 24.0 * 30.0))
          `,
      ),
    )
  }

  // ─── Reads for graph rendering ─────────────────────────────────────────

  /**
   * Full graph for a user: all live concepts + their edges + clusters.
   * `since` (optional) returns only rows changed after that timestamp — used
   * by the web client for delta sync on revisits.
   *
   * Edges are filtered by user and excluded if either endpoint is merged. We
   * select the few fields the UI actually needs to keep payloads small even
   * for power users with thousands of concepts.
   */
  async getGraph(
    userId: string,
    since?: Date,
  ): Promise<{
    concepts: Array<{
      id: string
      name: string
      kind: string
      mentionCount: number
      centralityScore: number
      lastMentionedAt: Date
      clusterId: string | null
      firstQuote: string | null
    }>
    edges: Array<{
      id: string
      sourceConceptId: string
      targetConceptId: string
      relationType: string
      weight: number
      mentionCount: number
      llmConfidence: number | null
    }>
    clusters: Array<{
      id: string
      label: string
      color: string
      conceptCount: number
      computedAt: Date
    }>
  }> {
    const concepts = await prisma.brainConcept.findMany({
      where: {
        userId,
        mergedIntoId: null,
        deletedAt: null,
        ...(since ? { updatedAt: { gt: since } } : {}),
      },
      select: {
        id: true,
        name: true,
        kind: true,
        mentionCount: true,
        centralityScore: true,
        lastMentionedAt: true,
        clusterId: true,
      },
    })

    // Highest-salience quote per concept for dual-coding hover. One raw query
    // with DISTINCT ON keeps this cheap regardless of concept count — Prisma
    // doesn't expose DISTINCT ON, so we drop into $queryRaw.
    const quoteRows = concepts.length
      ? await prisma.$queryRaw<Array<{ concept_id: string; quote: string | null }>>`
          SELECT DISTINCT ON (concept_id) concept_id, quote
          FROM brain_concept_occurrences
          WHERE concept_id = ANY(${concepts.map((c) => c.id)}::text[])
            AND quote IS NOT NULL
          ORDER BY concept_id, salience DESC, created_at DESC
        `
      : []
    const quoteByConcept = new Map(quoteRows.map((r) => [r.concept_id, r.quote]))
    const conceptsWithQuote = concepts.map((c) => ({
      ...c,
      firstQuote: quoteByConcept.get(c.id) ?? null,
    }))

    // Edges are kept around when one endpoint is soft-deleted, so we must
    // filter to alive↔alive pairs at read time. Fetch the full alive-id set
    // (not just delta) so an edge reinforced between two untouched concepts
    // still surfaces during delta sync.
    const aliveIdRows = since
      ? await prisma.brainConcept.findMany({
          where: { userId, mergedIntoId: null, deletedAt: null },
          select: { id: true },
        })
      : conceptsWithQuote.map((c) => ({ id: c.id }))
    const aliveIds = aliveIdRows.map((c) => c.id)
    const edges = aliveIds.length
      ? await prisma.brainConceptEdge.findMany({
          where: {
            userId,
            sourceConceptId: { in: aliveIds },
            targetConceptId: { in: aliveIds },
            ...(since ? { lastReinforcedAt: { gt: since } } : {}),
          },
          select: {
            id: true,
            sourceConceptId: true,
            targetConceptId: true,
            relationType: true,
            weight: true,
            mentionCount: true,
            llmConfidence: true,
          },
        })
      : []

    const clusters = await prisma.brainCluster.findMany({
      where: {
        userId,
        ...(since ? { computedAt: { gt: since } } : {}),
      },
      select: {
        id: true,
        label: true,
        color: true,
        conceptCount: true,
        computedAt: true,
      },
    })

    return { concepts: conceptsWithQuote, edges, clusters }
  }

  /**
   * Ego network: rootId + neighbours up to `depth` hops, weight-cut to keep
   * the payload manageable on densely-connected hubs.
   */
  async getEgoNetwork(
    userId: string,
    rootId: string,
    depth = 2,
    weightCutoff = 0.1,
  ): Promise<{
    concepts: Array<{
      id: string
      name: string
      kind: string
      mentionCount: number
      centralityScore: number
      lastMentionedAt: Date
      clusterId: string | null
    }>
    edges: Array<{
      id: string
      sourceConceptId: string
      targetConceptId: string
      relationType: string
      weight: number
      mentionCount: number
      llmConfidence: number | null
    }>
  }> {
    const visited = new Set<string>([rootId])
    let frontier: string[] = [rootId]

    for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
      const next = await prisma.brainConceptEdge.findMany({
        where: {
          userId,
          weight: { gte: weightCutoff },
          OR: [
            { sourceConceptId: { in: frontier } },
            { targetConceptId: { in: frontier } },
          ],
        },
        select: { sourceConceptId: true, targetConceptId: true },
      })
      const newcomers: string[] = []
      for (const e of next) {
        for (const id of [e.sourceConceptId, e.targetConceptId]) {
          if (!visited.has(id)) {
            visited.add(id)
            newcomers.push(id)
          }
        }
      }
      frontier = newcomers
    }

    const ids = Array.from(visited)
    const concepts = await prisma.brainConcept.findMany({
      where: { id: { in: ids }, mergedIntoId: null, deletedAt: null },
      select: {
        id: true,
        name: true,
        kind: true,
        mentionCount: true,
        centralityScore: true,
        lastMentionedAt: true,
        clusterId: true,
      },
    })

    // Restrict edges to surviving (alive) endpoints — soft-deleted concepts
    // were already pruned from `concepts` above.
    const aliveIds = concepts.map((c) => c.id)
    const edges = aliveIds.length
      ? await prisma.brainConceptEdge.findMany({
          where: {
            userId,
            weight: { gte: weightCutoff },
            sourceConceptId: { in: aliveIds },
            targetConceptId: { in: aliveIds },
          },
          select: {
            id: true,
            sourceConceptId: true,
            targetConceptId: true,
            relationType: true,
            weight: true,
            mentionCount: true,
            llmConfidence: true,
          },
        })
      : []

    return { concepts, edges }
  }

  // ─── Bulk read for clustering ──────────────────────────────────────────

  /**
   * All live concepts with their embeddings, used as input to the clustering
   * algorithm. Returns embeddings as plain number[] (Prisma can't return the
   * vector column natively, so we cast through text).
   */
  async allConceptsWithEmbeddings(
    userId: string,
  ): Promise<Array<{ id: string; embedding: number[] }>> {
    const rows = await prisma.$queryRaw<Array<{ id: string; embedding: string }>>`
      SELECT id, embedding::text AS embedding
      FROM brain_concepts
      WHERE user_id = ${userId}
        AND merged_into_id IS NULL
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
    `
    return rows.map((r) => ({
      id: r.id,
      // pgvector text format is "[0.123,0.456,...]"
      embedding: JSON.parse(r.embedding) as number[],
    }))
  }

  // ─── Cluster persistence (called by nightly cron) ──────────────────────

  /**
   * Atomically replace the user's clusters and reassign concept.cluster_id.
   * Called from runClustering — old clusters are dropped, new ones are
   * inserted with their centroid and member assignments. Concepts not in
   * any cluster have cluster_id reset to null.
   *
   * Label seed: the name of the highest-mention concept in the cluster.
   * Color seed: deterministic palette by cluster index. Phase 3 swaps these
   * for LLM-generated labels and a contrast-balanced palette.
   */
  async persistClusters(
    userId: string,
    clusters: Array<{ conceptIds: string[]; centroid: number[] }>,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // Detach all current cluster memberships for this user — concepts that
      // survive into a new cluster are reassigned below; the rest stay null.
      await tx.brainConcept.updateMany({
        where: { userId },
        data: { clusterId: null },
      })

      // Drop existing clusters; cascading FK from concepts is already handled
      // (clusterId is nullable with onDelete: SetNull, so even if the above
      // updateMany were skipped it would be safe).
      await tx.brainCluster.deleteMany({ where: { userId } })

      if (clusters.length === 0) return

      // For each cluster, pick the most-mentioned concept as the label seed.
      const allMemberIds = clusters.flatMap((c) => c.conceptIds)
      const members = await tx.brainConcept.findMany({
        where: { id: { in: allMemberIds } },
        select: { id: true, name: true, mentionCount: true },
      })
      const byId = new Map(members.map((m) => [m.id, m]))

      const palette = [
        '#6366f1',
        '#ec4899',
        '#10b981',
        '#f59e0b',
        '#06b6d4',
        '#8b5cf6',
        '#ef4444',
        '#14b8a6',
        '#f97316',
        '#3b82f6',
      ]

      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i]!
        const seed = c.conceptIds
          .map((id) => byId.get(id))
          .filter((m): m is { id: string; name: string; mentionCount: number } => !!m)
          .sort((a, b) => b.mentionCount - a.mentionCount)[0]
        const label = seed?.name ?? `Cluster ${i + 1}`
        const color = palette[i % palette.length]!
        const centroidVec = toPgVector(c.centroid)

        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO brain_clusters (
            id, user_id, label, color, centroid_embedding, concept_count, computed_at
          ) VALUES (
            gen_random_uuid()::text,
            ${userId},
            ${label},
            ${color},
            ${centroidVec}::vector,
            ${c.conceptIds.length},
            CURRENT_TIMESTAMP
          )
          RETURNING id
        `
        const clusterId = inserted[0]!.id
        await tx.brainConcept.updateMany({
          where: { id: { in: c.conceptIds } },
          data: { clusterId },
        })
      }
    })
  }

  // ─── Manual merge (user override of auto-dedupe) ───────────────────────

  /**
   * Merge `sourceId` INTO `targetId`. Source becomes a tombstone (mergedIntoId
   * = target). All occurrences and edges are reassigned to target with conflict
   * resolution. Atomic — wrapped in a single transaction.
   *
   * Throws on: not-found, cross-user, either side already merged, source==target.
   */
  async mergeConcepts(
    userId: string,
    sourceId: string,
    targetId: string,
  ): Promise<{ mergedConceptId: string; targetConceptId: string }> {
    if (sourceId === targetId) {
      throw new ConceptMergeError('SAME_ID', 'sourceId and targetId must differ')
    }

    return prisma.$transaction(async (tx) => {
      // 1. Validate ownership and merge state.
      const concepts = await tx.brainConcept.findMany({
        where: { id: { in: [sourceId, targetId] }, userId },
        select: { id: true, mergedIntoId: true, deletedAt: true },
      })
      if (concepts.length !== 2) {
        throw new ConceptMergeError('NOT_FOUND', 'one or both concepts not found for this user')
      }
      if (concepts.some((c) => c.mergedIntoId !== null)) {
        throw new ConceptMergeError('ALREADY_MERGED', 'one or both concepts are already merged')
      }
      if (concepts.some((c) => c.deletedAt !== null)) {
        throw new ConceptMergeError('DELETED', 'one or both concepts are deleted')
      }

      // 2. Move occurrences. Conflicts on (concept_id, entry_id) keep the
      //    higher salience and prefer existing quote (target wins ties).
      await tx.$executeRaw`
        INSERT INTO brain_concept_occurrences (id, concept_id, entry_id, salience, quote, created_at)
        SELECT gen_random_uuid()::text, ${targetId}, entry_id, salience, quote, created_at
        FROM brain_concept_occurrences
        WHERE concept_id = ${sourceId}
        ON CONFLICT (concept_id, entry_id) DO UPDATE
          SET salience = GREATEST(brain_concept_occurrences.salience, EXCLUDED.salience),
              quote = COALESCE(brain_concept_occurrences.quote, EXCLUDED.quote)
      `
      await tx.$executeRaw`
        DELETE FROM brain_concept_occurrences WHERE concept_id = ${sourceId}
      `

      // 3. Move edges. Each direction handled separately — the unique index
      //    is (source_concept_id, target_concept_id, relation_type) so a swap
      //    can collide with an existing target-side edge.
      await tx.$executeRaw`
        INSERT INTO brain_concept_edges (
          id, user_id, source_concept_id, target_concept_id,
          relation_type, weight, mention_count, last_reinforced_at, created_at, llm_confidence
        )
        SELECT gen_random_uuid()::text, user_id, ${targetId}, target_concept_id,
               relation_type, weight, mention_count, last_reinforced_at, created_at, llm_confidence
        FROM brain_concept_edges
        WHERE source_concept_id = ${sourceId} AND target_concept_id <> ${targetId}
        ON CONFLICT (source_concept_id, target_concept_id, relation_type) DO UPDATE
          SET mention_count = brain_concept_edges.mention_count + EXCLUDED.mention_count,
              weight = brain_concept_edges.weight + EXCLUDED.weight,
              last_reinforced_at = GREATEST(brain_concept_edges.last_reinforced_at, EXCLUDED.last_reinforced_at)
      `
      await tx.$executeRaw`
        INSERT INTO brain_concept_edges (
          id, user_id, source_concept_id, target_concept_id,
          relation_type, weight, mention_count, last_reinforced_at, created_at, llm_confidence
        )
        SELECT gen_random_uuid()::text, user_id, source_concept_id, ${targetId},
               relation_type, weight, mention_count, last_reinforced_at, created_at, llm_confidence
        FROM brain_concept_edges
        WHERE target_concept_id = ${sourceId} AND source_concept_id <> ${targetId}
        ON CONFLICT (source_concept_id, target_concept_id, relation_type) DO UPDATE
          SET mention_count = brain_concept_edges.mention_count + EXCLUDED.mention_count,
              weight = brain_concept_edges.weight + EXCLUDED.weight,
              last_reinforced_at = GREATEST(brain_concept_edges.last_reinforced_at, EXCLUDED.last_reinforced_at)
      `
      // Drop self-loops created by the merge (target↔target) and the originals.
      await tx.$executeRaw`
        DELETE FROM brain_concept_edges
        WHERE source_concept_id = ${sourceId}
           OR target_concept_id = ${sourceId}
           OR source_concept_id = target_concept_id
      `

      // 4. Bump target stats from source's metadata before tombstoning.
      await tx.$executeRaw`
        UPDATE brain_concepts
        SET mention_count = brain_concepts.mention_count + s.mention_count,
            last_mentioned_at = GREATEST(brain_concepts.last_mentioned_at, s.last_mentioned_at),
            updated_at = CURRENT_TIMESTAMP
        FROM (SELECT mention_count, last_mentioned_at FROM brain_concepts WHERE id = ${sourceId}) s
        WHERE brain_concepts.id = ${targetId}
      `

      // 5. Tombstone source. mergedIntoId points to target; reads filter this out.
      await tx.brainConcept.update({
        where: { id: sourceId },
        data: { mergedIntoId: targetId, updatedAt: new Date() },
      })

      return { mergedConceptId: sourceId, targetConceptId: targetId }
    })
  }

  // ─── Stats for clustering trigger ──────────────────────────────────────

  async newConceptsSince(userId: string, since: Date): Promise<number> {
    const count = await prisma.brainConcept.count({
      where: { userId, createdAt: { gt: since }, deletedAt: null },
    })
    return count
  }

  async lastClusterRunAt(userId: string): Promise<Date | null> {
    const row = await prisma.brainCluster.findFirst({
      where: { userId },
      orderBy: { computedAt: 'desc' },
      select: { computedAt: true },
    })
    return row?.computedAt ?? null
  }
}

export const brainGraphRepo = new BrainGraphRepository()

export type ConceptMergeErrorCode = 'SAME_ID' | 'NOT_FOUND' | 'ALREADY_MERGED' | 'DELETED'

export class ConceptMergeError extends Error {
  constructor(public readonly code: ConceptMergeErrorCode, message: string) {
    super(message)
    this.name = 'ConceptMergeError'
  }
}
