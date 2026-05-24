import type { DocumentSessionChange } from '../documentSession'
import type { ResolvedSelection } from '../selections'
import { wordRangeAtOffset } from './textRanges'

export type ExactOccurrenceRange = {
  readonly start: number
  readonly end: number
}

export type OccurrenceSelectionChange = {
  readonly change: DocumentSessionChange
  readonly revealOffset: number
}

export type OccurrenceQuery = {
  readonly query: string
  readonly range: ExactOccurrenceRange
}

export function getOccurrenceQuery(
  text: string,
  selections: readonly ResolvedSelection[],
): string | null {
  const selection = selections.find((candidate) => !candidate.collapsed)
  if (!selection) return null

  return text.slice(selection.startOffset, selection.endOffset)
}

export function occurrenceQueryForSelection(
  text: string,
  selection: ResolvedSelection,
): OccurrenceQuery | null {
  if (!selection.collapsed) {
    const query = text.slice(selection.startOffset, selection.endOffset)
    if (query.length === 0) return null
    return { query, range: { start: selection.startOffset, end: selection.endOffset } }
  }

  const range = wordRangeAtOffset(text, selection.headOffset)
  if (range.start === range.end) return null
  return { query: text.slice(range.start, range.end), range }
}

export function findAllExactOccurrences(
  text: string,
  query: string,
): readonly ExactOccurrenceRange[] {
  if (query.length === 0) return []

  const ranges: ExactOccurrenceRange[] = []
  let index = text.indexOf(query)
  while (index !== -1) {
    ranges.push({ start: index, end: index + query.length })
    index = text.indexOf(query, index + query.length)
  }
  return ranges
}

export function findNextExactOccurrence(
  text: string,
  query: string,
  selections: readonly ResolvedSelection[],
): ExactOccurrenceRange | null {
  if (query.length === 0) return null

  const selected = selections.map((selection) => ({
    start: selection.startOffset,
    end: selection.endOffset,
  }))
  const searchStart = selected.reduce((offset, range) => Math.max(offset, range.end), 0)
  return (
    findExactOccurrenceFrom(text, query, selected, searchStart) ??
    findExactOccurrenceFrom(text, query, selected, 0, searchStart)
  )
}

export function findNextExactOccurrenceFromRange(
  text: string,
  query: string,
  selected: readonly ExactOccurrenceRange[],
  range: ExactOccurrenceRange,
): ExactOccurrenceRange | null {
  if (query.length === 0) return null

  return (
    findExactOccurrenceFrom(text, query, selected, range.end) ??
    findExactOccurrenceFrom(text, query, selected, 0, range.end)
  )
}

export function occurrenceSelectTimingName(
  command: 'editor.action.selectHighlights' | 'editor.action.changeAll',
): string {
  if (command === 'editor.action.selectHighlights') return 'input.selectHighlights'
  return 'input.changeAll'
}

function findExactOccurrenceFrom(
  text: string,
  query: string,
  selected: readonly ExactOccurrenceRange[],
  start: number,
  end = text.length,
): ExactOccurrenceRange | null {
  let index = text.indexOf(query, start)

  while (index !== -1 && index < end) {
    const range = { start: index, end: index + query.length }
    if (!selected.some((selection) => rangesOverlap(selection, range))) return range
    index = text.indexOf(query, index + 1)
  }

  return null
}

function rangesOverlap(left: ExactOccurrenceRange, right: ExactOccurrenceRange): boolean {
  return left.start < right.end && right.start < left.end
}
