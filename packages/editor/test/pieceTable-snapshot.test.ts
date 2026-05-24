import { describe, expect, it } from 'vitest'

import { createInitialBuffers, createOriginalPiece } from '../src/pieceTable/buffers.ts'
import { PIECE_ORDER_STEP } from '../src/pieceTable/orders.ts'
import { buildReverseIndex } from '../src/pieceTable/reverseIndex.ts'
import {
  createPieceTableSnapshot,
  createSnapshot,
  createSnapshotWithIndex,
} from '../src/pieceTable/snapshot.ts'
import { createNode, flattenNodes } from '../src/pieceTable/tree.ts'

describe('piece table snapshots', () => {
  it('creates empty and non-empty initial snapshots', () => {
    const empty = createPieceTableSnapshot('')
    const text = createPieceTableSnapshot('abc')

    expect(empty).toMatchObject({ root: null, reverseIndexRoot: null, length: 0, pieceCount: 0 })
    expect(text.length).toBe(3)
    expect(text.pieceCount).toBe(1)
    expect(text.reverseIndexRoot).not.toBeNull()
  })

  it('derives aggregate length and piece count from the root', () => {
    const buffers = createInitialBuffers('abc')
    const root = createNode(createOriginalPiece(buffers)!)
    const snapshot = createSnapshot(buffers, root, buildReverseIndex(root))

    expect(snapshot.length).toBe(3)
    expect(snapshot.pieceCount).toBe(1)
  })

  it('normalizes piece orders and rebuilds the reverse index when requested', () => {
    const buffers = createInitialBuffers('abc')
    const root = createNode({ ...createOriginalPiece(buffers)!, order: 0 })
    const snapshot = createSnapshotWithIndex(buffers, root, null, true)
    const pieces = flattenNodes(snapshot.root, []).map((node) => node.piece)

    expect(pieces.map((piece) => piece.order)).toEqual([PIECE_ORDER_STEP])
    expect(snapshot.reverseIndexRoot?.order).toBe(PIECE_ORDER_STEP)
  })
})
