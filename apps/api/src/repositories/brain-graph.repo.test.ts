/**
 * Brain graph repository unit tests — focused on the soft-delete-aware paths:
 * concept revival in resolveConcepts (when an exact-name match finds a tombstoned
 * row) and the DELETED rejection in mergeConcepts. Raw vector SQL is mocked
 * away — we exercise the orchestration, not pgvector.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConceptFindUnique = vi.fn()
const mockConceptFindFirst = vi.fn()
const mockConceptFindMany = vi.fn()
const mockConceptUpdate = vi.fn()
const mockConceptUpdateMany = vi.fn()
const mockConceptDelete = vi.fn()
const mockOccurrenceDeleteMany = vi.fn()
const mockQueryRaw = vi.fn()
const mockExecuteRaw = vi.fn()

const mockTx = {
  brainConcept: {
    findFirst: (...a: unknown[]) => mockConceptFindFirst(...a),
    findMany: (...a: unknown[]) => mockConceptFindMany(...a),
    update: (...a: unknown[]) => mockConceptUpdate(...a),
    updateMany: (...a: unknown[]) => mockConceptUpdateMany(...a),
    delete: (...a: unknown[]) => mockConceptDelete(...a),
  },
  brainConceptOccurrence: {
    deleteMany: (...a: unknown[]) => mockOccurrenceDeleteMany(...a),
  },
  $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
}

vi.mock('../lib/prisma', () => ({
  prisma: {
    brainConcept: {
      findUnique: (...a: unknown[]) => mockConceptFindUnique(...a),
      findMany: (...a: unknown[]) => mockConceptFindMany(...a),
      update: (...a: unknown[]) => mockConceptUpdate(...a),
    },
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
    $transaction: (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
  },
}))

vi.mock('../lib/embeddings', () => ({
  toPgVector: (v: number[]) => `[${v.join(',')}]`,
}))

import { brainGraphRepo, ConceptMergeError, ConceptDeleteError } from './brain-graph.repo'

const dim1536 = (seed: number) => {
  const v = new Array(1536)
  for (let i = 0; i < 1536; i++) v[i] = Math.sin(seed + i) * 0.01
  return v
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('brainGraphRepo.resolveConcepts — revival', () => {
  it('revives a soft-deleted concept matched by exact normalized name', async () => {
    mockConceptFindUnique.mockResolvedValueOnce({
      id: 'c-revived',
      deletedAt: new Date('2026-04-01T00:00:00Z'),
    })
    mockConceptUpdate.mockResolvedValueOnce({ id: 'c-revived' })

    const result = await brainGraphRepo.resolveConcepts('user-1', [
      {
        name: 'Falcon',
        normalizedName: 'falcon',
        kind: 'project',
        embedding: dim1536(0),
        salience: 1,
      },
    ])

    expect(mockConceptUpdate).toHaveBeenCalledWith({
      where: { id: 'c-revived' },
      data: expect.objectContaining({
        deletedAt: null,
        mentionCount: 1,
        lastMentionedAt: expect.any(Date),
      }),
    })
    expect(result).toEqual([{ id: 'c-revived', inserted: false, similarity: 1 }])
    // Should not fall through to vector search after exact-match revival
    expect(mockQueryRaw).not.toHaveBeenCalled()
  })

  it('bumps mentionCount (no revival) when matched concept is alive', async () => {
    mockConceptFindUnique.mockResolvedValueOnce({ id: 'c-live', deletedAt: null })
    mockConceptUpdate.mockResolvedValueOnce({ id: 'c-live' })

    const result = await brainGraphRepo.resolveConcepts('user-1', [
      {
        name: 'María',
        normalizedName: 'maria',
        kind: 'person',
        embedding: dim1536(1),
        salience: 0.8,
      },
    ])

    // Live concept gets bumpMention path: increment + lastMentionedAt update,
    // crucially WITHOUT setting deletedAt: null (which would be a no-op but
    // signals the wrong code path).
    expect(mockConceptUpdate).toHaveBeenCalledWith({
      where: { id: 'c-live' },
      data: expect.not.objectContaining({ deletedAt: null }),
    })
    expect(result).toEqual([{ id: 'c-live', inserted: false, similarity: 1 }])
  })
})

describe('brainGraphRepo.mergeConcepts — soft-delete guard', () => {
  it('throws ConceptMergeError(DELETED) when source is soft-deleted', async () => {
    mockConceptFindMany.mockResolvedValueOnce([
      { id: 'src', mergedIntoId: null, deletedAt: new Date() },
      { id: 'tgt', mergedIntoId: null, deletedAt: null },
    ])

    await expect(
      brainGraphRepo.mergeConcepts('user-1', 'src', 'tgt'),
    ).rejects.toMatchObject({
      name: 'ConceptMergeError',
      code: 'DELETED',
    })
    expect(mockExecuteRaw).not.toHaveBeenCalled()
  })

  it('throws ConceptMergeError(DELETED) when target is soft-deleted', async () => {
    mockConceptFindMany.mockResolvedValueOnce([
      { id: 'src', mergedIntoId: null, deletedAt: null },
      { id: 'tgt', mergedIntoId: null, deletedAt: new Date() },
    ])

    await expect(
      brainGraphRepo.mergeConcepts('user-1', 'src', 'tgt'),
    ).rejects.toBeInstanceOf(ConceptMergeError)
  })

  it('throws SAME_ID without touching the DB when source equals target', async () => {
    await expect(
      brainGraphRepo.mergeConcepts('user-1', 'same', 'same'),
    ).rejects.toMatchObject({ code: 'SAME_ID' })
    expect(mockConceptFindMany).not.toHaveBeenCalled()
  })

  it('throws NOT_FOUND when one side is missing for the user', async () => {
    mockConceptFindMany.mockResolvedValueOnce([
      { id: 'src', mergedIntoId: null, deletedAt: null },
    ])

    await expect(
      brainGraphRepo.mergeConcepts('user-1', 'src', 'missing'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('brainGraphRepo.deleteConceptByUser', () => {
  it('hard-deletes the concept (cascades occurrences and edges via FK)', async () => {
    mockConceptFindFirst.mockResolvedValueOnce({
      id: 'c-1',
      deletedAt: null,
      mergedIntoId: null,
    })
    mockConceptDelete.mockResolvedValueOnce({ id: 'c-1' })

    const result = await brainGraphRepo.deleteConceptByUser('user-1', 'c-1')

    expect(result).toEqual({ id: 'c-1' })
    expect(mockConceptDelete).toHaveBeenCalledWith({ where: { id: 'c-1' } })
  })

  it('also hard-deletes a previously soft-deleted concept (finishes the job)', async () => {
    mockConceptFindFirst.mockResolvedValueOnce({
      id: 'c-1',
      deletedAt: new Date(),
      mergedIntoId: null,
    })
    mockConceptDelete.mockResolvedValueOnce({ id: 'c-1' })

    const result = await brainGraphRepo.deleteConceptByUser('user-1', 'c-1')

    expect(result).toEqual({ id: 'c-1' })
    expect(mockConceptDelete).toHaveBeenCalled()
  })

  it('throws NOT_FOUND when concept is missing or belongs to another user', async () => {
    mockConceptFindFirst.mockResolvedValueOnce(null)

    await expect(
      brainGraphRepo.deleteConceptByUser('user-1', 'missing'),
    ).rejects.toMatchObject({ name: 'ConceptDeleteError', code: 'NOT_FOUND' })
    expect(mockConceptDelete).not.toHaveBeenCalled()
  })

  it('throws ALREADY_MERGED when concept is a tombstone for another concept', async () => {
    mockConceptFindFirst.mockResolvedValueOnce({
      id: 'c-1',
      deletedAt: null,
      mergedIntoId: 'c-2',
    })

    await expect(
      brainGraphRepo.deleteConceptByUser('user-1', 'c-1'),
    ).rejects.toBeInstanceOf(ConceptDeleteError)
    expect(mockConceptDelete).not.toHaveBeenCalled()
  })
})
