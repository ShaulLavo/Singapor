import type { Piece, PieceTableTreeSnapshot } from './pieceTableTypes'
import { getBufferText } from './buffers'
import { collectTextInRange, forEachTextInRange } from './tree'

export const getPieceTableLength = (snapshot: PieceTableTreeSnapshot): number => snapshot.length

export const getPieceTableOriginalText = (snapshot: PieceTableTreeSnapshot): string =>
  getBufferText(snapshot.buffers, snapshot.buffers.original)

export const ensureValidRange = (snapshot: PieceTableTreeSnapshot, start: number, end: number) => {
  if (start < 0 || end < start || end > snapshot.length) {
    throw new RangeError('invalid range')
  }
}

export const readPieceTableRange = (
  snapshot: PieceTableTreeSnapshot,
  start = 0,
  end?: number,
): string => {
  const effectiveEnd = end ?? snapshot.length
  ensureValidRange(snapshot, start, effectiveEnd)
  if (start === effectiveEnd) return ''

  const chunks: string[] = []
  collectTextInRange(snapshot.root, snapshot.buffers, start, effectiveEnd, chunks)
  return chunks.join('')
}

export const materializePieceTableText = (snapshot: PieceTableTreeSnapshot): string =>
  readPieceTableRange(snapshot, 0, snapshot.length)

export const getPieceTableText = (
  snapshot: PieceTableTreeSnapshot,
  start = 0,
  end?: number,
): string => {
  if (start === 0 && end === undefined) return materializePieceTableText(snapshot)
  return readPieceTableRange(snapshot, start, end)
}

export const streamPieceTableTextChunks = (
  snapshot: PieceTableTreeSnapshot,
  visit: (text: string, start: number, end: number) => void,
  start = 0,
  end?: number,
): void => {
  const effectiveEnd = end ?? snapshot.length
  ensureValidRange(snapshot, start, effectiveEnd)
  if (start === effectiveEnd) return
  let offset = start
  forEachTextInRange(snapshot.root, snapshot.buffers, start, effectiveEnd, (buffer, from, to) => {
    const text = buffer.slice(from, to)
    const nextOffset = offset + text.length
    visit(text, offset, nextOffset)
    offset = nextOffset
  })
}

export const forEachPieceTableTextChunk = streamPieceTableTextChunks

export type PieceTablePieceStreamEntry = {
  readonly piece: Piece
  readonly text: string
  readonly start: number
  readonly end: number
}

export const streamPieceTablePieces = (
  snapshot: PieceTableTreeSnapshot,
  visit: (entry: PieceTablePieceStreamEntry) => void,
  start = 0,
  end?: number,
): void => {
  const effectiveEnd = end ?? snapshot.length
  ensureValidRange(snapshot, start, effectiveEnd)
  if (start === effectiveEnd) return
  streamPieces(snapshot.root, snapshot, visit, start, effectiveEnd)
}

export const pieceTableSnapshotsHaveSameText = (
  left: PieceTableTreeSnapshot,
  right: PieceTableTreeSnapshot,
): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  if (left.length === 0) return true
  return pieceTableTextChunksEqual(
    collectPieceTableTextChunks(left),
    collectPieceTableTextChunks(right),
  )
}

const streamPieces = (
  node: PieceTableTreeSnapshot['root'],
  snapshot: PieceTableTreeSnapshot,
  visit: (entry: PieceTablePieceStreamEntry) => void,
  start: number,
  end: number,
  baseOffset = 0,
): void => {
  if (!node || baseOffset >= end) return

  const leftLength = node.left?.subtreeVisibleLength ?? 0
  const pieceLength = node.piece.visible ? node.piece.length : 0
  const pieceStart = baseOffset + leftLength
  const pieceEnd = pieceStart + pieceLength

  if (start < pieceStart) streamPieces(node.left, snapshot, visit, start, end, baseOffset)
  streamCurrentPiece(node.piece, snapshot, visit, start, end, pieceStart, pieceEnd)
  if (end > pieceEnd) streamPieces(node.right, snapshot, visit, start, end, pieceEnd)
}

const streamCurrentPiece = (
  piece: Piece,
  snapshot: PieceTableTreeSnapshot,
  visit: (entry: PieceTablePieceStreamEntry) => void,
  start: number,
  end: number,
  pieceStart: number,
  pieceEnd: number,
): void => {
  if (!piece.visible || pieceEnd <= start || pieceStart >= end) return

  const localStart = Math.max(0, start - pieceStart)
  const localEnd = Math.min(piece.length, end - pieceStart)
  if (localEnd <= localStart) return

  const buffer = getBufferText(snapshot.buffers, piece.buffer)
  visit({
    piece,
    text: buffer.slice(piece.start + localStart, piece.start + localEnd),
    start: pieceStart + localStart,
    end: pieceStart + localEnd,
  })
}

type PieceTableTextChunk = {
  readonly text: string
  readonly start: number
  readonly end: number
}

const collectPieceTableTextChunks = (
  snapshot: PieceTableTreeSnapshot,
): readonly PieceTableTextChunk[] => {
  const chunks: PieceTableTextChunk[] = []
  forEachTextInRange(snapshot.root, snapshot.buffers, 0, snapshot.length, (text, start, end) => {
    chunks.push({ text, start, end })
  })
  return chunks
}

const pieceTableTextChunksEqual = (
  left: readonly PieceTableTextChunk[],
  right: readonly PieceTableTextChunk[],
): boolean => {
  let leftIndex = 0
  let rightIndex = 0
  let leftOffset = left[0]?.start ?? 0
  let rightOffset = right[0]?.start ?? 0

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftChunk = left[leftIndex]
    const rightChunk = right[rightIndex]
    if (!leftChunk || !rightChunk) return false

    const length = Math.min(leftChunk.end - leftOffset, rightChunk.end - rightOffset)
    if (!pieceTableTextRangesEqual(leftChunk, leftOffset, rightChunk, rightOffset, length)) {
      return false
    }

    leftOffset += length
    rightOffset += length
    if (leftOffset === leftChunk.end) {
      leftIndex += 1
      leftOffset = left[leftIndex]?.start ?? 0
    }
    if (rightOffset === rightChunk.end) {
      rightIndex += 1
      rightOffset = right[rightIndex]?.start ?? 0
    }
  }

  return leftIndex === left.length && rightIndex === right.length
}

const pieceTableTextRangesEqual = (
  left: PieceTableTextChunk,
  leftOffset: number,
  right: PieceTableTextChunk,
  rightOffset: number,
  length: number,
): boolean => {
  for (let index = 0; index < length; index += 1) {
    const leftCode = left.text.charCodeAt(leftOffset + index)
    const rightCode = right.text.charCodeAt(rightOffset + index)
    if (leftCode !== rightCode) return false
  }
  return true
}
