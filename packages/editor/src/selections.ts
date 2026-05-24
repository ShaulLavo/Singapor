import type {
  Anchor as PieceTableAnchor,
  AnchorBias,
  AnchorLiveness,
  PieceTableEdit,
  PieceTableSnapshot,
} from './pieceTable/pieceTableTypes'
import { anchorAt, resolveAnchor } from './pieceTable/anchors'
import { applyBatchToPieceTable } from './pieceTable/edits'
import { offsetToPoint, pointToOffset } from './pieceTable/positions'
import { getPieceTableText } from './pieceTable/reads'
import { normalizeTabSize } from './displayTransforms'

export type SelectionGoal =
  | { readonly kind: 'none' }
  | { readonly kind: 'horizontal'; readonly x: number }
  | { readonly kind: 'horizontalRange'; readonly anchorX: number; readonly headX: number }

export const SelectionGoal = {
  none: (): SelectionGoal => ({ kind: 'none' }),
  horizontal: (x: number): SelectionGoal => ({ kind: 'horizontal', x }),
  horizontalRange: (anchorX: number, headX: number): SelectionGoal => ({
    kind: 'horizontalRange',
    anchorX,
    headX,
  }),
} as const

export type Selection<T> = {
  readonly id: string
  readonly start: T
  readonly end: T
  readonly reversed: boolean
  readonly goal: SelectionGoal
}

export type AnchorSelection = Selection<PieceTableAnchor>

export type SelectionSet<T> = {
  readonly selections: readonly Selection<T>[]
  readonly normalized: boolean
  readonly normalizedFor?: PieceTableSnapshot
}

export type ResolvedSelection = {
  readonly id: string
  readonly startOffset: number
  readonly endOffset: number
  readonly anchorOffset: number
  readonly headOffset: number
  readonly reversed: boolean
  readonly collapsed: boolean
  readonly goal: SelectionGoal
  readonly liveness: AnchorLiveness
  readonly startLiveness: AnchorLiveness
  readonly endLiveness: AnchorLiveness
}

export type SelectionEditResult = {
  readonly snapshot: PieceTableSnapshot
  readonly selections: SelectionSet<PieceTableAnchor>
  readonly edits: readonly PieceTableEdit[]
}

export type CreateAnchorSelectionOptions = {
  readonly id?: string
  readonly goal?: SelectionGoal
  readonly cursorBias?: AnchorBias
  readonly reversed?: boolean
}

type OffsetRange = {
  readonly start: number
  readonly end: number
}

type ResolvedSelectionWithSource = ResolvedSelection & {
  readonly source: AnchorSelection
}

let nextSelectionId = 0

const createSelectionId = (): string => `selection:${nextSelectionId++}`

const orderOffsets = (first: number, second: number): OffsetRange => ({
  start: Math.min(first, second),
  end: Math.max(first, second),
})

const rangeLength = (range: OffsetRange): number => range.end - range.start

const resolvedSelectionRange = (selection: ResolvedSelection): OffsetRange => ({
  start: selection.startOffset,
  end: selection.endOffset,
})

const lastItem = <T>(items: readonly T[]): T | null => {
  if (items.length === 0) return null
  return items[items.length - 1] ?? null
}

const isLiveSelection = (
  startLiveness: AnchorLiveness,
  endLiveness: AnchorLiveness,
): AnchorLiveness => {
  if (startLiveness === 'live' && endLiveness === 'live') return 'live'
  return 'deleted'
}

const createEndpointAnchors = (
  snapshot: PieceTableSnapshot,
  range: OffsetRange,
  cursorBias: AnchorBias,
): { start: PieceTableAnchor; end: PieceTableAnchor } => {
  if (range.start === range.end) {
    const cursor = anchorAt(snapshot, range.start, cursorBias)
    return { start: cursor, end: cursor }
  }

  return {
    start: anchorAt(snapshot, range.start, 'left'),
    end: anchorAt(snapshot, range.end, 'right'),
  }
}

export const createAnchorSelection = (
  snapshot: PieceTableSnapshot,
  anchorOffset: number,
  headOffset = anchorOffset,
  options: CreateAnchorSelectionOptions = {},
): AnchorSelection => {
  const range = orderOffsets(anchorOffset, headOffset)
  const cursorBias = options.cursorBias ?? 'right'
  const endpoints = createEndpointAnchors(snapshot, range, cursorBias)
  const collapsed = range.start === range.end
  const reversed = collapsed ? false : (options.reversed ?? headOffset < anchorOffset)

  return {
    id: options.id ?? createSelectionId(),
    start: endpoints.start,
    end: endpoints.end,
    reversed,
    goal: options.goal ?? SelectionGoal.none(),
  }
}

export const createSelectionSet = <T>(
  selections: readonly Selection<T>[],
  normalized = false,
  normalizedFor?: PieceTableSnapshot,
): SelectionSet<T> => ({
  selections,
  normalized,
  normalizedFor: normalized ? normalizedFor : undefined,
})

export const markSelectionSetDirty = <T>(set: SelectionSet<T>): SelectionSet<T> => ({
  selections: set.selections,
  normalized: false,
  normalizedFor: undefined,
})

export const resolveSelection = (
  snapshot: PieceTableSnapshot,
  selection: AnchorSelection,
): ResolvedSelection => {
  const start = resolveAnchor(snapshot, selection.start)
  const end = resolveAnchor(snapshot, selection.end)
  const range = orderOffsets(start.offset, end.offset)
  const collapsed = range.start === range.end
  const reversed = collapsed ? false : selection.reversed

  return {
    id: selection.id,
    startOffset: range.start,
    endOffset: range.end,
    anchorOffset: reversed ? range.end : range.start,
    headOffset: reversed ? range.start : range.end,
    reversed,
    collapsed,
    goal: selection.goal,
    liveness: isLiveSelection(start.liveness, end.liveness),
    startLiveness: start.liveness,
    endLiveness: end.liveness,
  }
}

const resolveSelectionWithSource = (
  snapshot: PieceTableSnapshot,
  selection: AnchorSelection,
): ResolvedSelectionWithSource => ({
  ...resolveSelection(snapshot, selection),
  source: selection,
})

const compareResolvedSelections = (
  left: ResolvedSelectionWithSource,
  right: ResolvedSelectionWithSource,
): number => {
  if (left.startOffset !== right.startOffset) return left.startOffset - right.startOffset
  if (left.endOffset !== right.endOffset) return left.endOffset - right.endOffset
  return left.id.localeCompare(right.id)
}

const shouldMergeRanges = (left: OffsetRange, right: OffsetRange): boolean =>
  right.start <= left.end

const selectionFromResolved = (
  snapshot: PieceTableSnapshot,
  resolved: ResolvedSelectionWithSource,
): AnchorSelection =>
  createAnchorSelection(snapshot, resolved.anchorOffset, resolved.headOffset, {
    id: resolved.id,
    goal: resolved.goal,
    reversed: resolved.reversed,
  })

const normalizeResolvedSelection = (
  snapshot: PieceTableSnapshot,
  resolved: ResolvedSelectionWithSource,
): ResolvedSelectionWithSource => {
  const source = selectionFromResolved(snapshot, resolved)
  return {
    ...resolveSelection(snapshot, source),
    source,
  }
}

const mergeResolvedSelections = (
  snapshot: PieceTableSnapshot,
  left: ResolvedSelectionWithSource,
  right: ResolvedSelectionWithSource,
): ResolvedSelectionWithSource => {
  const startOffset = Math.min(left.startOffset, right.startOffset)
  const endOffset = Math.max(left.endOffset, right.endOffset)
  const source = createAnchorSelection(snapshot, startOffset, endOffset, {
    id: left.id,
    goal: SelectionGoal.none(),
    reversed: false,
  })

  return {
    ...resolveSelection(snapshot, source),
    source,
  }
}

export const normalizeSelections = (
  snapshot: PieceTableSnapshot,
  selections: readonly AnchorSelection[],
): AnchorSelection[] => {
  const resolved = selections.map((selection) => resolveSelectionWithSource(snapshot, selection))
  const sorted = resolved.toSorted(compareResolvedSelections)
  const normalized: ResolvedSelectionWithSource[] = []

  for (const selection of sorted) {
    const previous = lastItem(normalized)
    if (!previous) {
      normalized.push(normalizeResolvedSelection(snapshot, selection))
      continue
    }

    if (!shouldMergeRanges(resolvedSelectionRange(previous), resolvedSelectionRange(selection))) {
      normalized.push(normalizeResolvedSelection(snapshot, selection))
      continue
    }

    normalized[normalized.length - 1] = mergeResolvedSelections(snapshot, previous, selection)
  }

  return normalized.map((selection) => selection.source)
}

export const normalizeSelectionSet = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): SelectionSet<PieceTableAnchor> => {
  if (set.normalized && set.normalizedFor === snapshot) return set

  return {
    selections: normalizeSelections(snapshot, set.selections),
    normalized: true,
    normalizedFor: snapshot,
  }
}

const resolvedSelectionsToRanges = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): ResolvedSelection[] => {
  const normalized = normalizeSelectionSet(snapshot, set)
  return normalized.selections.map((selection) => resolveSelection(snapshot, selection))
}

const rangeToEdit = (range: OffsetRange, text: string): PieceTableEdit => ({
  from: range.start,
  to: range.end,
  text,
})

const collapseSelectionsAfterEdits = (
  snapshot: PieceTableSnapshot,
  ranges: readonly OffsetRange[],
  text: string,
): SelectionSet<PieceTableAnchor> => {
  let delta = 0
  const selections: AnchorSelection[] = []

  for (const range of ranges) {
    const caretOffset = range.start + delta + text.length
    selections.push(
      createAnchorSelection(snapshot, caretOffset, caretOffset, { cursorBias: 'left' }),
    )
    delta += text.length - rangeLength(range)
  }

  return createSelectionSet(selections, true, snapshot)
}

export const applyTextToSelections = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
  text: string,
): SelectionEditResult => {
  const ranges = resolvedSelectionsToRanges(snapshot, set).map((selection) => ({
    start: selection.startOffset,
    end: selection.endOffset,
  }))
  const edits = ranges.map((range) => rangeToEdit(range, text))
  const nextSnapshot = applyBatchToPieceTable(snapshot, edits)

  return {
    snapshot: nextSnapshot,
    selections: collapseSelectionsAfterEdits(nextSnapshot, ranges, text),
    edits,
  }
}

export const indentSelections = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
  text: string,
): SelectionEditResult => {
  if (text.length === 0) return emptySelectionEdit(snapshot, set)

  const selections = resolvedSelectionsToRanges(snapshot, set)
  const rows = touchedRowsForSelections(snapshot, selections)
  const edits = rows.map((row) =>
    rangeToEdit({ start: lineStart(snapshot, row), end: lineStart(snapshot, row) }, text),
  )
  const nextSnapshot = applyBatchToPieceTable(snapshot, edits)

  return {
    snapshot: nextSnapshot,
    selections: createSelectionSet(
      selections.map((selection) => indentSelectionAfterEdits(nextSnapshot, selection, edits)),
      true,
      nextSnapshot,
    ),
    edits,
  }
}

export const outdentSelections = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
  tabSize: number,
): SelectionEditResult => {
  const normalizedTabSize = normalizeTabSize(tabSize)
  const selections = resolvedSelectionsToRanges(snapshot, set)
  const rows = touchedRowsForSelections(snapshot, selections)
  const edits = rows
    .map((row) => outdentEditForRow(snapshot, row, normalizedTabSize))
    .filter((edit): edit is PieceTableEdit => edit !== null)
  if (edits.length === 0) return emptySelectionEdit(snapshot, set)

  const nextSnapshot = applyBatchToPieceTable(snapshot, edits)
  return {
    snapshot: nextSnapshot,
    selections: createSelectionSet(
      selections.map((selection) => outdentSelectionAfterEdits(nextSnapshot, selection, edits)),
      true,
      nextSnapshot,
    ),
    edits,
  }
}

export const deleteSelections = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): SelectionEditResult => {
  const normalized = normalizeSelectionSet(snapshot, set)
  const ranges = normalized.selections
    .map((selection) => resolveSelection(snapshot, selection))
    .filter((selection) => !selection.collapsed)
    .map((selection) => ({
      start: selection.startOffset,
      end: selection.endOffset,
    }))
  const edits = ranges.map((range) => rangeToEdit(range, ''))
  const nextSnapshot = applyBatchToPieceTable(snapshot, edits)

  if (edits.length === 0) {
    return {
      snapshot: nextSnapshot,
      selections: normalized,
      edits,
    }
  }

  return {
    snapshot: nextSnapshot,
    selections: collapseSelectionsAfterEdits(nextSnapshot, ranges, ''),
    edits,
  }
}

const previousCodePointOffset = (snapshot: PieceTableSnapshot, offset: number): number => {
  if (offset <= 0) return 0
  if (offset < 2) return offset - 1

  const text = getPieceTableText(snapshot, offset - 2, offset)
  const before = text.charCodeAt(0)
  const after = text.charCodeAt(1)
  const beforeIsHighSurrogate = before >= 0xd800 && before <= 0xdbff
  const afterIsLowSurrogate = after >= 0xdc00 && after <= 0xdfff
  if (beforeIsHighSurrogate && afterIsLowSurrogate) return offset - 2

  return offset - 1
}

const emptySelectionEdit = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): SelectionEditResult => ({
  snapshot,
  selections: normalizeSelectionSet(snapshot, set),
  edits: [],
})

const touchedRowsForSelections = (
  snapshot: PieceTableSnapshot,
  selections: readonly ResolvedSelection[],
): number[] => {
  const rows = new Set<number>()
  for (const selection of selections) {
    for (
      let row = firstTouchedRow(snapshot, selection);
      row <= lastTouchedRow(snapshot, selection);
      row += 1
    ) {
      rows.add(row)
    }
  }

  return Array.from(rows).sort((left, right) => left - right)
}

const firstTouchedRow = (snapshot: PieceTableSnapshot, selection: ResolvedSelection): number =>
  offsetToPoint(snapshot, selection.startOffset).row

const lastTouchedRow = (snapshot: PieceTableSnapshot, selection: ResolvedSelection): number => {
  const end = offsetToPoint(snapshot, selection.endOffset)
  if (selection.collapsed) return end.row
  if (end.column !== 0) return end.row
  return Math.max(firstTouchedRow(snapshot, selection), end.row - 1)
}

const lineStart = (snapshot: PieceTableSnapshot, row: number): number =>
  pointToOffset(snapshot, { row, column: 0 })

const lineEnd = (snapshot: PieceTableSnapshot, row: number): number =>
  pointToOffset(snapshot, { row, column: Number.MAX_SAFE_INTEGER })

const outdentEditForRow = (
  snapshot: PieceTableSnapshot,
  row: number,
  tabSize: number,
): PieceTableEdit | null => {
  const start = lineStart(snapshot, row)
  const end = lineEnd(snapshot, row)
  if (start >= end) return null

  const prefix = getPieceTableText(snapshot, start, Math.min(end, start + tabSize))
  const length = outdentLength(prefix, tabSize)
  if (length === 0) return null
  return rangeToEdit({ start, end: start + length }, '')
}

const outdentLength = (text: string, tabSize: number): number => {
  if (text[0] === '\t') return 1

  let spaces = 0
  while (spaces < text.length && spaces < tabSize && text[spaces] === ' ') spaces += 1
  return spaces
}

const indentSelectionAfterEdits = (
  snapshot: PieceTableSnapshot,
  selection: ResolvedSelection,
  edits: readonly PieceTableEdit[],
): AnchorSelection =>
  createAnchorSelection(
    snapshot,
    indentOffsetAfterEdits(selection.anchorOffset, edits),
    indentOffsetAfterEdits(selection.headOffset, edits),
    selectionOptions(selection),
  )

const indentOffsetAfterEdits = (offset: number, edits: readonly PieceTableEdit[]): number => {
  let delta = 0
  for (const edit of edits) {
    if (edit.from >= offset) continue
    delta += edit.text.length
  }

  return offset + delta
}

const outdentSelectionAfterEdits = (
  snapshot: PieceTableSnapshot,
  selection: ResolvedSelection,
  edits: readonly PieceTableEdit[],
): AnchorSelection =>
  createAnchorSelection(
    snapshot,
    outdentOffsetAfterEdits(selection.anchorOffset, edits),
    outdentOffsetAfterEdits(selection.headOffset, edits),
    selectionOptions(selection),
  )

const outdentOffsetAfterEdits = (offset: number, edits: readonly PieceTableEdit[]): number => {
  let delta = 0
  for (const edit of edits) {
    if (offset <= edit.from) break
    if (offset < edit.to) return edit.from + delta
    delta -= edit.to - edit.from
  }

  return offset + delta
}

const selectionOptions = (selection: ResolvedSelection): CreateAnchorSelectionOptions => ({
  id: selection.id,
  goal: selection.goal,
  reversed: selection.reversed,
})

const backspaceRangeForSelection = (
  snapshot: PieceTableSnapshot,
  selection: ResolvedSelection,
): OffsetRange | null => {
  if (!selection.collapsed) return { start: selection.startOffset, end: selection.endOffset }
  if (selection.startOffset === 0) return null

  return {
    start: previousCodePointOffset(snapshot, selection.startOffset),
    end: selection.startOffset,
  }
}

const mergeOffsetRanges = (ranges: readonly OffsetRange[]): OffsetRange[] => {
  const sorted = ranges.toSorted((left, right) => left.start - right.start || left.end - right.end)
  const merged: OffsetRange[] = []

  for (const range of sorted) {
    const previous = lastItem(merged)
    if (!previous || range.start > previous.end) {
      merged.push(range)
      continue
    }

    merged[merged.length - 1] = {
      start: previous.start,
      end: Math.max(previous.end, range.end),
    }
  }

  return merged
}

export const backspaceSelections = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): SelectionEditResult => {
  const normalized = normalizeSelectionSet(snapshot, set)
  const ranges = normalized.selections
    .map((selection) => resolveSelection(snapshot, selection))
    .map((selection) => backspaceRangeForSelection(snapshot, selection))
    .filter((range): range is OffsetRange => range !== null)
  const mergedRanges = mergeOffsetRanges(ranges)
  const edits = mergedRanges.map((range) => rangeToEdit(range, ''))
  const nextSnapshot = applyBatchToPieceTable(snapshot, edits)

  if (edits.length === 0) {
    return {
      snapshot: nextSnapshot,
      selections: normalized,
      edits,
    }
  }

  return {
    snapshot: nextSnapshot,
    selections: collapseSelectionsAfterEdits(nextSnapshot, mergedRanges, ''),
    edits,
  }
}
