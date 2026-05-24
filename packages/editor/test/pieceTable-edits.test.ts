import { describe, expect, it } from 'vitest'

import {
  applyBatchToPieceTable,
  deleteFromPieceTable,
  insertIntoPieceTable,
} from '../src/pieceTable/edits.ts'
import { createPieceTableSnapshot } from '../src/pieceTable/pieceTable.ts'
import { getPieceTableText } from '../src/pieceTable/reads.ts'

describe('piece table edits', () => {
  it('inserts and deletes text while preserving the original snapshot', () => {
    const initial = createPieceTableSnapshot('hello')
    const inserted = insertIntoPieceTable(initial, 5, ' world')
    const deleted = deleteFromPieceTable(inserted, 5, 1)

    expect(getPieceTableText(initial)).toBe('hello')
    expect(getPieceTableText(inserted)).toBe('hello world')
    expect(getPieceTableText(deleted)).toBe('helloworld')
  })

  it('returns the same snapshot for no-op edits', () => {
    const snapshot = createPieceTableSnapshot('abc')

    expect(insertIntoPieceTable(snapshot, 1, '')).toBe(snapshot)
    expect(deleteFromPieceTable(snapshot, 1, 0)).toBe(snapshot)
    expect(applyBatchToPieceTable(snapshot, [])).toBe(snapshot)
  })

  it('applies non-overlapping batch edits against the original text', () => {
    const snapshot = createPieceTableSnapshot('abcdef')
    const edited = applyBatchToPieceTable(snapshot, [
      { from: 1, to: 3, text: 'XX' },
      { from: 4, to: 6, text: 'Y' },
    ])

    expect(getPieceTableText(edited)).toBe('aXXdY')
    expect(getPieceTableText(snapshot)).toBe('abcdef')
  })

  it('rejects invalid or overlapping ranges', () => {
    const snapshot = createPieceTableSnapshot('abc')

    expect(() => insertIntoPieceTable(snapshot, 4, 'x')).toThrow(RangeError)
    expect(() => deleteFromPieceTable(snapshot, 1, 4)).toThrow(RangeError)
    expect(() =>
      applyBatchToPieceTable(snapshot, [
        { from: 0, to: 2, text: 'x' },
        { from: 1, to: 3, text: 'y' },
      ]),
    ).toThrow(RangeError)
  })
})
