/**
 * Brain repository unit tests — focused on the cascade cleanup that runs when
 * an entry is soft-deleted or reprocessed. Prisma is fully mocked; we verify
 * the orchestration: occurrence delete, orphan-vs-survivor split, concept
 * soft-delete vs mentionCount decrement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockBrainEntryUpdateMany = vi.fn()
const mockBrainEntryFindUnique = vi.fn()
const mockOccurrenceFindMany = vi.fn()
const mockOccurrenceDeleteMany = vi.fn()
const mockOccurrenceGroupBy = vi.fn()
const mockConceptUpdateMany = vi.fn()

const mockTx = {
  brainEntry: {
    updateMany: (...a: unknown[]) => mockBrainEntryUpdateMany(...a),
    findUnique: (...a: unknown[]) => mockBrainEntryFindUnique(...a),
  },
  brainConceptOccurrence: {
    findMany: (...a: unknown[]) => mockOccurrenceFindMany(...a),
    deleteMany: (...a: unknown[]) => mockOccurrenceDeleteMany(...a),
    groupBy: (...a: unknown[]) => mockOccurrenceGroupBy(...a),
  },
  brainConcept: {
    updateMany: (...a: unknown[]) => mockConceptUpdateMany(...a),
  },
}

vi.mock('../lib/prisma', () => ({
  prisma: {
    $transaction: (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
  },
}))

import { brainRepo } from './brain.repo'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('brainRepo.softDelete', () => {
  it('returns false when no entry matches', async () => {
    mockBrainEntryUpdateMany.mockResolvedValueOnce({ count: 0 })

    const ok = await brainRepo.softDelete('entry-x', 'user-1')

    expect(ok).toBe(false)
    expect(mockOccurrenceFindMany).not.toHaveBeenCalled()
    expect(mockConceptUpdateMany).not.toHaveBeenCalled()
  })

  it('returns true and skips cleanup when entry has no occurrences', async () => {
    mockBrainEntryUpdateMany.mockResolvedValueOnce({ count: 1 })
    mockOccurrenceFindMany.mockResolvedValueOnce([])

    const ok = await brainRepo.softDelete('entry-1', 'user-1')

    expect(ok).toBe(true)
    expect(mockOccurrenceDeleteMany).not.toHaveBeenCalled()
    expect(mockConceptUpdateMany).not.toHaveBeenCalled()
  })

  it('soft-deletes orphan concepts and decrements survivors', async () => {
    mockBrainEntryUpdateMany.mockResolvedValueOnce({ count: 1 })
    // Entry mentions 3 concepts: c-orphan-a, c-orphan-b (only here), c-shared (also elsewhere)
    mockOccurrenceFindMany.mockResolvedValueOnce([
      { conceptId: 'c-orphan-a' },
      { conceptId: 'c-orphan-b' },
      { conceptId: 'c-shared' },
    ])
    mockOccurrenceDeleteMany.mockResolvedValueOnce({ count: 3 })
    // After deletion only c-shared still has occurrences elsewhere
    mockOccurrenceGroupBy.mockResolvedValueOnce([{ conceptId: 'c-shared' }])
    mockConceptUpdateMany.mockResolvedValue({ count: 0 })

    const ok = await brainRepo.softDelete('entry-1', 'user-1')

    expect(ok).toBe(true)
    expect(mockOccurrenceDeleteMany).toHaveBeenCalledWith({ where: { entryId: 'entry-1' } })
    // Orphans get soft-deleted
    expect(mockConceptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['c-orphan-a', 'c-orphan-b'] }, userId: 'user-1' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    )
    // Survivor's mentionCount decremented
    expect(mockConceptUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c-shared'] }, userId: 'user-1' },
      data: { mentionCount: { decrement: 1 } },
    })
  })

  it('handles all-orphan case (no survivors)', async () => {
    mockBrainEntryUpdateMany.mockResolvedValueOnce({ count: 1 })
    mockOccurrenceFindMany.mockResolvedValueOnce([{ conceptId: 'c-1' }, { conceptId: 'c-2' }])
    mockOccurrenceDeleteMany.mockResolvedValueOnce({ count: 2 })
    mockOccurrenceGroupBy.mockResolvedValueOnce([])
    mockConceptUpdateMany.mockResolvedValue({ count: 0 })

    const ok = await brainRepo.softDelete('entry-1', 'user-1')

    expect(ok).toBe(true)
    // Only one updateMany call: the orphan soft-delete. No decrement call.
    expect(mockConceptUpdateMany).toHaveBeenCalledTimes(1)
    expect(mockConceptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    )
  })
})

describe('brainRepo.resetToPending', () => {
  it('returns null when no entry matches', async () => {
    mockBrainEntryUpdateMany.mockResolvedValueOnce({ count: 0 })

    const result = await brainRepo.resetToPending('entry-x', 'user-1')

    expect(result).toBeNull()
    expect(mockOccurrenceFindMany).not.toHaveBeenCalled()
  })

  it('cleans up occurrences before returning the entry', async () => {
    mockBrainEntryUpdateMany.mockResolvedValueOnce({ count: 1 })
    mockOccurrenceFindMany.mockResolvedValueOnce([{ conceptId: 'c-1' }])
    mockOccurrenceDeleteMany.mockResolvedValueOnce({ count: 1 })
    // c-1 has no other occurrences → orphan
    mockOccurrenceGroupBy.mockResolvedValueOnce([])
    mockConceptUpdateMany.mockResolvedValueOnce({ count: 1 })
    mockBrainEntryFindUnique.mockResolvedValueOnce({ id: 'entry-1', status: 'pending' })

    const result = await brainRepo.resetToPending('entry-1', 'user-1')

    expect(result).toEqual({ id: 'entry-1', status: 'pending' })
    expect(mockOccurrenceDeleteMany).toHaveBeenCalledWith({ where: { entryId: 'entry-1' } })
    expect(mockConceptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['c-1'] }, userId: 'user-1' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    )
  })
})
