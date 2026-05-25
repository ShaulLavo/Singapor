import {
  createDisplayRowsFromLines,
  type BlockRow,
  type DisplayRow,
  type InjectedTextRow,
} from '../displayTransforms'
import type { TextSnapshot } from '../documentTextSnapshot'
import { foldPointToBufferPoint, type FoldMap, type FoldPoint } from '../foldMap'

export type VirtualizedTextProjectionInput = {
  readonly textSnapshot: TextSnapshot
  readonly lineStarts: readonly number[]
  readonly foldMap: FoldMap | null
  readonly blockRows: readonly BlockRow[]
  readonly injectedTextRows: readonly InjectedTextRow[]
  readonly wrapColumn: number | null
  readonly tabSize: number
}

export type VirtualizedTextViewModel = {
  readonly textSnapshot: TextSnapshot
  readonly textLength: number
  readonly lineCount: number
  readonly visibleLineCount: number
  readonly foldMap: FoldMap | null
  readonly wrapColumn: number | null
  readonly blockRows: readonly BlockRow[]
  readonly injectedTextRows: readonly InjectedTextRow[]
  readonly tabSize: number
  readonly rows: readonly DisplayRow[]
}

export function createVirtualizedTextViewModel(
  input: VirtualizedTextProjectionInput,
): VirtualizedTextViewModel {
  const textLength = input.textSnapshot.length
  const lineCount = Math.max(1, input.lineStarts.length)
  const foldMap = foldMapForText(input.foldMap, textLength)
  const visibleLineCount = foldedVisibleLineCount(lineCount, foldMap)
  const rows = createDisplayRowsFromLines({
    visibleLineCount,
    bufferRowForVisibleRow: (row) => bufferRowForVisibleRow(row, lineCount, foldMap),
    lineText: (row) => lineText(input.textSnapshot, input.lineStarts, textLength, row),
    lineStartOffset: (row) => lineStartOffset(input.lineStarts, textLength, row),
    lineEndOffset: (row) => lineEndOffset(input.lineStarts, textLength, row),
    wrapColumn: input.wrapColumn,
    blocks: input.blockRows,
    injectedTextRows: input.injectedTextRows,
    tabSize: input.tabSize,
  })

  return {
    textSnapshot: input.textSnapshot,
    textLength,
    lineCount,
    visibleLineCount,
    foldMap,
    wrapColumn: input.wrapColumn,
    blockRows: input.blockRows,
    injectedTextRows: input.injectedTextRows,
    tabSize: input.tabSize,
    rows,
  }
}

function foldMapForText(foldMap: FoldMap | null, textLength: number): FoldMap | null {
  if (!foldMap) return null
  if (foldMap.snapshot.length !== textLength) return null
  return foldMap
}

function foldedVisibleLineCount(lineCount: number, foldMap: FoldMap | null): number {
  if (!foldMap) return lineCount

  const hidden = foldMap.ranges.reduce((count, range) => {
    return count + Math.max(0, range.endPoint.row - range.startPoint.row)
  }, 0)
  return Math.max(1, lineCount - hidden)
}

function bufferRowForVisibleRow(row: number, lineCount: number, foldMap: FoldMap | null): number {
  if (!foldMap) return clampRow(row, lineCount)

  const point = foldPointToBufferPoint(foldMap, { row, column: 0 } as FoldPoint)
  return clampRow(point.row, lineCount)
}

function lineText(
  snapshot: TextSnapshot,
  lineStarts: readonly number[],
  textLength: number,
  row: number,
): string {
  return snapshot.readRange(
    lineStartOffset(lineStarts, textLength, row),
    lineEndOffset(lineStarts, textLength, row),
  )
}

function lineStartOffset(lineStarts: readonly number[], textLength: number, row: number): number {
  if (row < 0) return textLength
  return lineStarts[row] ?? textLength
}

function lineEndOffset(lineStarts: readonly number[], textLength: number, row: number): number {
  if (row < 0) return textLength

  const nextLineStart = lineStarts[row + 1]
  if (nextLineStart === undefined) return textLength
  return Math.max(lineStartOffset(lineStarts, textLength, row), nextLineStart - 1)
}

function clampRow(row: number, lineCount: number): number {
  if (!Number.isFinite(row)) return 0
  return Math.min(Math.max(0, Math.floor(row)), Math.max(0, lineCount - 1))
}
