import type {
  PieceTableBuffers,
  PieceTableReverseIndexNode,
  PieceTableTreeSnapshot,
  PieceTreeNode,
} from './pieceTableTypes'
import { createInitialBuffers, createOriginalPiece, type PieceTableBufferOptions } from './buffers'
import { buildReverseIndex } from './reverseIndex'
import { createNode, getSubtreePieces, getSubtreeVisibleLength, normalizePieceOrders } from './tree'
import { PIECE_ORDER_STEP } from './orders'
import { priorityForPiece } from './priority'

export const createSnapshot = (
  buffers: PieceTableBuffers,
  root: PieceTreeNode | null,
  reverseIndexRoot: PieceTableReverseIndexNode | null,
): PieceTableTreeSnapshot => ({
  buffers,
  root,
  reverseIndexRoot,
  length: getSubtreeVisibleLength(root),
  pieceCount: getSubtreePieces(root),
})

export const createSnapshotWithIndex = (
  buffers: PieceTableBuffers,
  root: PieceTreeNode | null,
  reverseIndexRoot: PieceTableReverseIndexNode | null,
  normalizeOrders: boolean,
): PieceTableTreeSnapshot => {
  if (!normalizeOrders) return createSnapshot(buffers, root, reverseIndexRoot)

  const normalizedRoot = normalizePieceOrders(root, { value: PIECE_ORDER_STEP })
  return createSnapshot(
    buffers,
    normalizedRoot,
    buildReverseIndex(normalizedRoot, buffers.prioritySeed),
  )
}

export type CreatePieceTableSnapshotOptions = PieceTableBufferOptions

export const createPieceTableSnapshot = (
  original: string,
  options: CreatePieceTableSnapshotOptions = {},
): PieceTableTreeSnapshot => {
  const buffers = createInitialBuffers(original, options)
  const originalPiece = createOriginalPiece(buffers)
  const root = originalPiece
    ? createNode(originalPiece, null, null, priorityForPiece(originalPiece, buffers.prioritySeed))
    : null
  return createSnapshot(buffers, root, buildReverseIndex(root, buffers.prioritySeed))
}
