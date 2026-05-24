import type { PieceTableTreeSnapshot } from './pieceTableTypes'
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

export const getPieceTableText = (
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

export const forEachPieceTableTextChunk = (
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
