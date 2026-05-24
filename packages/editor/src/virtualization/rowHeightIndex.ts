export type RowHeightIndex = {
  readonly rowSizes: readonly number[]
  readonly rowStarts: readonly number[]
  readonly totalSize: number
}

export function createRowHeightIndex(rowSizes: readonly number[], rowGap: number): RowHeightIndex {
  const rowStarts = Array.from({ length: rowSizes.length + 1 }, () => 0)
  let offset = 0
  rowStarts[0] = offset

  for (let row = 0; row < rowSizes.length; row += 1) {
    offset += rowSizes[row] ?? 0
    if (row < rowSizes.length - 1) offset += rowGap
    rowStarts[row + 1] = offset
  }

  return { rowSizes, rowStarts, totalSize: offset }
}

export function rowHeightIndexStart(index: RowHeightIndex, row: number): number {
  return index.rowStarts[clampRowBoundary(row, index.rowSizes.length)] ?? index.totalSize
}

export function rowHeightIndexRowAtOffset(index: RowHeightIndex, offset: number): number {
  const count = index.rowSizes.length
  if (count === 0) return 0

  const normalizedOffset = normalizeOffset(offset)
  if (normalizedOffset >= index.totalSize) return count - 1

  const row = clampRow(upperBound(index.rowStarts, normalizedOffset) - 1, count)
  const rowEnd = rowHeightIndexStart(index, row) + (index.rowSizes[row] ?? 0)
  if (normalizedOffset < rowEnd) return row

  return Math.min(row + 1, count - 1)
}

export function rowHeightIndexRowAfterOffset(index: RowHeightIndex, offset: number): number {
  const count = index.rowSizes.length
  if (count === 0) return 0

  return Math.min(lowerBound(index.rowStarts, normalizeOffset(offset)), count)
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((values[middle] ?? 0) >= target) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((values[middle] ?? 0) > target) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function clampRow(row: number, count: number): number {
  if (!Number.isFinite(row) || row <= 0) return 0
  if (row >= count) return count - 1
  return Math.floor(row)
}

function clampRowBoundary(row: number, count: number): number {
  if (!Number.isFinite(row) || row <= 0) return 0
  if (row >= count) return count
  return Math.floor(row)
}

function normalizeOffset(offset: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0
  return offset
}
