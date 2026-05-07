/**
 * Brain Graph service — Phase 2 read-side + clustering orchestration.
 *
 * Wraps brain-graph.repo with feature gating, DTO shaping, and the clustering
 * orchestration loop (called by the nightly cron and by an admin trigger).
 *
 * Read endpoints:
 *   - getGraph: full per-user graph for the 3D view, with optional `since`
 *     cursor for delta sync.
 *   - getEgoNetwork: 1- or 2-hop neighbourhood around a focused concept.
 *
 * Write/orchestration:
 *   - runClustering: pull all concepts → agglomerative cluster → persist
 *     with new labels/colors/centroids.
 *
 * The graph view is gated behind FEATURES.BRAIN_GRAPH (paid plans). Free-tier
 * users get a 403 from the route layer; this service double-checks defensively.
 */
import { brainGraphRepo, ConceptMergeError, ConceptDeleteError } from '../repositories/brain-graph.repo'
import { agglomerativeCluster } from '../lib/clustering'
import { featuresService } from './features.service'
import { conceptExtractionService } from './concept-extraction.service'
import { FEATURES } from '@repo/shared/constants'
import type {
  BrainGraphResponse,
  BrainEgoNetworkResponse,
  BrainConceptNode,
  BrainConceptEdgeDto,
  BrainClusterDto,
  BrainConceptKind,
  BrainEdgeRelationType,
} from '@repo/shared/types'

class BrainGraphService {
  async getGraph(userId: string, since?: Date): Promise<BrainGraphResponse> {
    await this.assertFeature(userId)

    const { concepts, edges, clusters } = await brainGraphRepo.getGraph(userId, since)
    return {
      concepts: concepts.map(toConceptDto),
      edges: edges.map(toEdgeDto),
      clusters: clusters.map(toClusterDto),
      cursor: new Date().toISOString(),
    }
  }

  async getEgoNetwork(
    userId: string,
    rootId: string,
    depth = 2,
  ): Promise<BrainEgoNetworkResponse> {
    await this.assertFeature(userId)

    const safeDepth = Math.max(1, Math.min(3, depth))
    const { concepts, edges } = await brainGraphRepo.getEgoNetwork(userId, rootId, safeDepth)
    return {
      rootId,
      concepts: concepts.map(toConceptDto),
      edges: edges.map(toEdgeDto),
    }
  }

  /**
   * Run agglomerative clustering for one user and persist the result. Cron
   * invokes this for every user where `shouldRecluster()` is true.
   */
  async runClustering(userId: string): Promise<{
    clustersCreated: number
    conceptsAssigned: number
    skipped?: 'too_few_concepts' | 'feature_off'
  }> {
    const features = await featuresService.resolveFeatures(userId)
    if (!features[FEATURES.BRAIN_GRAPH]?.enabled) {
      return { clustersCreated: 0, conceptsAssigned: 0, skipped: 'feature_off' }
    }

    const concepts = await brainGraphRepo.allConceptsWithEmbeddings(userId)
    // Below this floor the agglomerative output would be empty anyway (min
    // cluster size = 3) and we waste a write transaction.
    if (concepts.length < 3) {
      return { clustersCreated: 0, conceptsAssigned: 0, skipped: 'too_few_concepts' }
    }

    const clusters = agglomerativeCluster(concepts)
    await brainGraphRepo.persistClusters(userId, clusters)

    return {
      clustersCreated: clusters.length,
      conceptsAssigned: clusters.reduce((acc, c) => acc + c.conceptIds.length, 0),
    }
  }

  /**
   * Manual merge from the UI: user picks two concepts that the auto-dedupe
   * missed and folds source INTO target. Source becomes a tombstone.
   */
  async mergeConcepts(
    userId: string,
    sourceId: string,
    targetId: string,
  ): Promise<{ mergedConceptId: string; targetConceptId: string }> {
    await this.assertFeature(userId)
    return brainGraphRepo.mergeConcepts(userId, sourceId, targetId)
  }

  /**
   * Manual concept delete from the UI. Hard-deletes the row (cascading its
   * occurrences and edges) so the user gets exactly what the confirm dialog
   * promised: a new mention creates a fresh concept.
   */
  async deleteConcept(userId: string, conceptId: string): Promise<{ id: string }> {
    await this.assertFeature(userId)
    return brainGraphRepo.deleteConceptByUser(userId, conceptId)
  }

  /**
   * Wrapper used by the cron — returns true if the user is overdue. Mirrors
   * concept-extraction.service.shouldRecluster so the cron only needs one
   * import.
   */
  async shouldRecluster(userId: string): Promise<boolean> {
    return conceptExtractionService.shouldRecluster(userId)
  }

  private async assertFeature(userId: string) {
    const features = await featuresService.resolveFeatures(userId)
    if (!features[FEATURES.BRAIN_GRAPH]?.enabled) {
      throw new BrainGraphFeatureError()
    }
  }
}

export class BrainGraphFeatureError extends Error {
  readonly code = 'BRAIN_GRAPH_DISABLED'
  constructor() {
    super('Brain graph feature is not enabled for this user')
  }
}

export { ConceptMergeError, ConceptDeleteError }

// ─── DTO mappers ─────────────────────────────────────────────────────────

function toConceptDto(c: {
  id: string
  name: string
  kind: string
  mentionCount: number
  centralityScore: number
  lastMentionedAt: Date
  clusterId: string | null
  firstQuote?: string | null
}): BrainConceptNode {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind as BrainConceptKind,
    mentionCount: c.mentionCount,
    centralityScore: c.centralityScore,
    lastMentionedAt: c.lastMentionedAt.toISOString(),
    clusterId: c.clusterId,
    firstQuote: c.firstQuote ?? null,
  }
}

function toEdgeDto(e: {
  id: string
  sourceConceptId: string
  targetConceptId: string
  relationType: string
  weight: number
  mentionCount: number
  llmConfidence: number | null
}): BrainConceptEdgeDto {
  return {
    id: e.id,
    sourceId: e.sourceConceptId,
    targetId: e.targetConceptId,
    relationType: e.relationType as BrainEdgeRelationType,
    weight: e.weight,
    mentionCount: e.mentionCount,
    llmConfidence: e.llmConfidence,
  }
}

function toClusterDto(c: {
  id: string
  label: string
  color: string
  conceptCount: number
  computedAt: Date
}): BrainClusterDto {
  return {
    id: c.id,
    label: c.label,
    color: c.color,
    conceptCount: c.conceptCount,
    computedAt: c.computedAt.toISOString(),
  }
}

export const brainGraphService = new BrainGraphService()
