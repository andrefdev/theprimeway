/**
 * Brain graph service unit tests — feature gating, DTO shaping, clustering
 * orchestration. We mock the repo + features + concept-extraction so no DB or
 * LLM call happens. The clustering library itself is real and exercised here
 * end-to-end through runClustering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockGetGraph = vi.fn()
const mockGetEgo = vi.fn()
const mockAllConceptsWithEmbeddings = vi.fn()
const mockPersistClusters = vi.fn()
const mockDeleteConceptByUser = vi.fn()

const { FakeConceptDeleteError } = vi.hoisted(() => {
  class FakeConceptDeleteError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.name = 'ConceptDeleteError'
      this.code = code
    }
  }
  return { FakeConceptDeleteError }
})

vi.mock('../repositories/brain-graph.repo', () => ({
  brainGraphRepo: {
    getGraph: (...args: unknown[]) => mockGetGraph(...args),
    getEgoNetwork: (...args: unknown[]) => mockGetEgo(...args),
    allConceptsWithEmbeddings: (...args: unknown[]) => mockAllConceptsWithEmbeddings(...args),
    persistClusters: (...args: unknown[]) => mockPersistClusters(...args),
    deleteConceptByUser: (...args: unknown[]) => mockDeleteConceptByUser(...args),
  },
  ConceptMergeError: class extends Error {},
  ConceptDeleteError: FakeConceptDeleteError,
}))

const mockResolveFeatures = vi.fn()
vi.mock('./features.service', () => ({
  featuresService: {
    resolveFeatures: (...args: unknown[]) => mockResolveFeatures(...args),
  },
}))

const mockShouldRecluster = vi.fn()
vi.mock('./concept-extraction.service', () => ({
  conceptExtractionService: {
    shouldRecluster: (...args: unknown[]) => mockShouldRecluster(...args),
  },
}))

// ─── Imports under test ────────────────────────────────────────────────────

import { brainGraphService, BrainGraphFeatureError } from './brain-graph.service'
import { FEATURES } from '@repo/shared/constants'

const USER = 'user_42'
const featureOn = { [FEATURES.BRAIN_GRAPH]: { enabled: true } }
const featureOff = { [FEATURES.BRAIN_GRAPH]: { enabled: false } }

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── getGraph ──────────────────────────────────────────────────────────────

describe('brainGraphService.getGraph', () => {
  it('throws BrainGraphFeatureError when the feature is off', async () => {
    mockResolveFeatures.mockResolvedValue(featureOff)
    await expect(brainGraphService.getGraph(USER)).rejects.toBeInstanceOf(BrainGraphFeatureError)
    expect(mockGetGraph).not.toHaveBeenCalled()
  })

  it('shapes repo rows into DTOs and forwards `since` cursor', async () => {
    mockResolveFeatures.mockResolvedValue(featureOn)
    const lastMentioned = new Date('2026-04-01T12:00:00Z')
    const computedAt = new Date('2026-04-02T08:00:00Z')
    mockGetGraph.mockResolvedValue({
      concepts: [
        {
          id: 'c1',
          name: 'Falcon',
          kind: 'project',
          mentionCount: 4,
          centralityScore: 0.7,
          lastMentionedAt: lastMentioned,
          clusterId: 'cl1',
        },
      ],
      edges: [
        {
          id: 'e1',
          sourceConceptId: 'c1',
          targetConceptId: 'c2',
          relationType: 'co_mentioned',
          weight: 2.3,
          mentionCount: 3,
          llmConfidence: null,
        },
      ],
      clusters: [
        { id: 'cl1', label: 'Falcon', color: '#6366f1', conceptCount: 5, computedAt },
      ],
    })

    const since = new Date('2026-03-01T00:00:00Z')
    const result = await brainGraphService.getGraph(USER, since)

    expect(mockGetGraph).toHaveBeenCalledWith(USER, since)
    expect(result.concepts[0]).toMatchObject({
      id: 'c1',
      name: 'Falcon',
      kind: 'project',
      lastMentionedAt: lastMentioned.toISOString(),
      clusterId: 'cl1',
    })
    expect(result.edges[0]).toMatchObject({
      id: 'e1',
      sourceId: 'c1',
      targetId: 'c2',
      relationType: 'co_mentioned',
    })
    expect(result.clusters[0]).toMatchObject({
      id: 'cl1',
      label: 'Falcon',
      computedAt: computedAt.toISOString(),
    })
    expect(result.cursor).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

// ─── getEgoNetwork ─────────────────────────────────────────────────────────

describe('brainGraphService.getEgoNetwork', () => {
  it('clamps depth to [1,3]', async () => {
    mockResolveFeatures.mockResolvedValue(featureOn)
    mockGetEgo.mockResolvedValue({ concepts: [], edges: [] })

    await brainGraphService.getEgoNetwork(USER, 'c1', 0)
    expect(mockGetEgo).toHaveBeenLastCalledWith(USER, 'c1', 1)

    await brainGraphService.getEgoNetwork(USER, 'c1', 99)
    expect(mockGetEgo).toHaveBeenLastCalledWith(USER, 'c1', 3)
  })

  it('returns the requested rootId in the response', async () => {
    mockResolveFeatures.mockResolvedValue(featureOn)
    mockGetEgo.mockResolvedValue({ concepts: [], edges: [] })

    const result = await brainGraphService.getEgoNetwork(USER, 'c-root', 2)
    expect(result.rootId).toBe('c-root')
  })

  it('rejects unauthorized users with BrainGraphFeatureError', async () => {
    mockResolveFeatures.mockResolvedValue(featureOff)
    await expect(brainGraphService.getEgoNetwork(USER, 'c1')).rejects.toBeInstanceOf(
      BrainGraphFeatureError,
    )
  })
})

// ─── runClustering ─────────────────────────────────────────────────────────

describe('brainGraphService.runClustering', () => {
  it('skips silently when feature is off', async () => {
    mockResolveFeatures.mockResolvedValue(featureOff)
    const result = await brainGraphService.runClustering(USER)
    expect(result).toEqual({ clustersCreated: 0, conceptsAssigned: 0, skipped: 'feature_off' })
    expect(mockAllConceptsWithEmbeddings).not.toHaveBeenCalled()
    expect(mockPersistClusters).not.toHaveBeenCalled()
  })

  it('skips when fewer than 3 concepts (min cluster size floor)', async () => {
    mockResolveFeatures.mockResolvedValue(featureOn)
    mockAllConceptsWithEmbeddings.mockResolvedValue([
      { id: 'a', embedding: [1, 0, 0, 0] },
      { id: 'b', embedding: [0, 1, 0, 0] },
    ])
    const result = await brainGraphService.runClustering(USER)
    expect(result.skipped).toBe('too_few_concepts')
    expect(mockPersistClusters).not.toHaveBeenCalled()
  })

  it('clusters concepts and persists the result', async () => {
    mockResolveFeatures.mockResolvedValue(featureOn)
    mockAllConceptsWithEmbeddings.mockResolvedValue([
      // Tight group of 3 — should form one cluster
      { id: 'a', embedding: [1, 0, 0, 0] },
      { id: 'b', embedding: [0.99, 0.05, 0, 0] },
      { id: 'c', embedding: [0.95, 0.1, 0, 0] },
      // Lone point — should be excluded by min size
      { id: 'z', embedding: [0, 0, 1, 0] },
    ])

    const result = await brainGraphService.runClustering(USER)

    expect(result.skipped).toBeUndefined()
    expect(result.clustersCreated).toBe(1)
    expect(result.conceptsAssigned).toBe(3)
    expect(mockPersistClusters).toHaveBeenCalledTimes(1)
    const [calledUserId, clusters] = mockPersistClusters.mock.calls[0]!
    expect(calledUserId).toBe(USER)
    expect(clusters).toHaveLength(1)
    expect(new Set(clusters[0].conceptIds)).toEqual(new Set(['a', 'b', 'c']))
  })
})

// ─── shouldRecluster proxy ─────────────────────────────────────────────────

describe('brainGraphService.shouldRecluster', () => {
  it('proxies to concept-extraction.service.shouldRecluster', async () => {
    mockShouldRecluster.mockResolvedValue(true)
    const result = await brainGraphService.shouldRecluster(USER)
    expect(result).toBe(true)
    expect(mockShouldRecluster).toHaveBeenCalledWith(USER)
  })
})

// ─── deleteConcept ─────────────────────────────────────────────────────────

describe('brainGraphService.deleteConcept', () => {
  it('throws BrainGraphFeatureError when the feature is off', async () => {
    mockResolveFeatures.mockResolvedValue(featureOff)
    await expect(brainGraphService.deleteConcept(USER, 'c1')).rejects.toBeInstanceOf(
      BrainGraphFeatureError,
    )
    expect(mockDeleteConceptByUser).not.toHaveBeenCalled()
  })

  it('forwards to repo.softDeleteConcept and returns its result', async () => {
    mockResolveFeatures.mockResolvedValue(featureOn)
    mockDeleteConceptByUser.mockResolvedValue({ id: 'c1' })

    const result = await brainGraphService.deleteConcept(USER, 'c1')

    expect(mockDeleteConceptByUser).toHaveBeenCalledWith(USER, 'c1')
    expect(result).toEqual({ id: 'c1' })
  })

  it('lets ConceptDeleteError propagate so the route can map status codes', async () => {
    mockResolveFeatures.mockResolvedValue(featureOn)
    mockDeleteConceptByUser.mockRejectedValue(new FakeConceptDeleteError('NOT_FOUND', 'nope'))

    await expect(brainGraphService.deleteConcept(USER, 'c-missing')).rejects.toMatchObject({
      name: 'ConceptDeleteError',
      code: 'NOT_FOUND',
    })
  })
})
