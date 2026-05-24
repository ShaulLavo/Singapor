import { describe, expect, it } from 'vitest'

import { insertIntoPieceTable } from '../src/pieceTable/edits.ts'
import { createPieceTableSnapshot } from '../src/pieceTable/pieceTable.ts'
import { offsetToPoint, pointToOffset } from '../src/pieceTable/positions.ts'

describe('piece table positions', () => {
  it('converts offsets to points at line boundaries', () => {
    const snapshot = createPieceTableSnapshot('ab\ncde\n\nf')

    expect(offsetToPoint(snapshot, 0)).toEqual({ row: 0, column: 0 })
    expect(offsetToPoint(snapshot, 2)).toEqual({ row: 0, column: 2 })
    expect(offsetToPoint(snapshot, 3)).toEqual({ row: 1, column: 0 })
    expect(offsetToPoint(snapshot, 7)).toEqual({ row: 2, column: 0 })
    expect(offsetToPoint(snapshot, 8)).toEqual({ row: 3, column: 0 })
    expect(offsetToPoint(snapshot, 9)).toEqual({ row: 3, column: 1 })
  })

  it('converts points to offsets and clamps outside line bounds', () => {
    const snapshot = createPieceTableSnapshot('ab\ncde\n\nf')

    expect(pointToOffset(snapshot, { row: -1, column: -1 })).toBe(0)
    expect(pointToOffset(snapshot, { row: 0, column: 99 })).toBe(2)
    expect(pointToOffset(snapshot, { row: 1, column: 2 })).toBe(5)
    expect(pointToOffset(snapshot, { row: 2, column: 99 })).toBe(7)
    expect(pointToOffset(snapshot, { row: 99, column: 0 })).toBe(9)
  })

  it('round-trips every offset after edits split pieces', () => {
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot('ab\ncd'), 3, 'XX\n')

    for (let offset = 0; offset <= snapshot.length; offset += 1) {
      expect(pointToOffset(snapshot, offsetToPoint(snapshot, offset))).toBe(offset)
    }
  })
})
