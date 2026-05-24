import type { FoldRange } from '../syntax/session'

export type FoldOperation = 'fold' | 'unfold' | 'toggle'

export function foldCandidateAtLocation(
  folds: readonly FoldRange[],
  row: number,
  offset: number,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): FoldRange | null {
  let candidate: FoldRange | null = null

  for (const fold of folds) {
    if (!foldContainsLocation(fold, row, offset)) continue
    if (!foldMatchesOperation(fold, isCollapsed, operation)) continue
    if (candidate && compareFoldCandidates(candidate, fold, row, isCollapsed, operation) <= 0)
      continue
    candidate = fold
  }

  return candidate
}

function foldContainsLocation(fold: FoldRange, row: number, offset: number): boolean {
  if (fold.startLine === row) return true
  return offset >= fold.startIndex && offset < fold.endIndex
}

function foldMatchesOperation(
  fold: FoldRange,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): boolean {
  const collapsed = isCollapsed(fold)
  if (operation === 'fold') return !collapsed
  if (operation === 'unfold') return collapsed
  return true
}

function compareFoldCandidates(
  left: FoldRange,
  right: FoldRange,
  row: number,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): number {
  const startRowDelta = foldStartRowScore(left, row) - foldStartRowScore(right, row)
  if (startRowDelta !== 0) return startRowDelta

  const collapsedDelta =
    foldCollapsedScore(left, isCollapsed, operation) -
    foldCollapsedScore(right, isCollapsed, operation)
  if (collapsedDelta !== 0) return collapsedDelta

  const spanDelta = foldSpanCandidateDelta(left, right, isCollapsed, operation)
  if (spanDelta !== 0) return spanDelta

  return left.startIndex - right.startIndex
}

function foldCollapsedScore(
  fold: FoldRange,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): number {
  if (operation !== 'toggle') return 0
  return isCollapsed(fold) ? 0 : 1
}

function foldSpanCandidateDelta(
  left: FoldRange,
  right: FoldRange,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): number {
  if (shouldPreferOutermostFold(left, right, isCollapsed, operation)) {
    return foldSpan(right) - foldSpan(left)
  }

  return foldSpan(left) - foldSpan(right)
}

function shouldPreferOutermostFold(
  left: FoldRange,
  right: FoldRange,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): boolean {
  if (operation === 'unfold') return true
  if (operation !== 'toggle') return false
  return isCollapsed(left) && isCollapsed(right)
}

function foldStartRowScore(fold: FoldRange, row: number): number {
  return fold.startLine === row ? 0 : 1
}

function foldSpan(fold: FoldRange): number {
  return fold.endIndex - fold.startIndex
}
