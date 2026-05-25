import { normalizeTabSize } from './displayTransforms'
import { applyBatchToPieceTable } from './pieceTable/edits'
import { offsetToPoint, pointToOffset } from './pieceTable/positions'
import { readPieceTableTextRange } from './pieceTable/reads'
import type {
  Anchor as PieceTableAnchor,
  PieceTableEdit,
  PieceTableSnapshot,
} from './pieceTable/pieceTableTypes'
import {
  createAnchorSelection,
  createSelectionSet,
  normalizeSelectionSet,
  resolveSelection,
  type AnchorSelection,
  type CreateAnchorSelectionOptions,
  type ResolvedSelection,
  type SelectionGoal,
  type SelectionSet,
} from './selections'

export type SelectionEditResult = {
  readonly snapshot: PieceTableSnapshot
  readonly selections: SelectionSet<PieceTableAnchor>
  readonly edits: readonly PieceTableEdit[]
}

type OffsetRange = {
  readonly start: number
  readonly end: number
}

type SelectionEditTarget = {
  readonly range: OffsetRange
  readonly id: string
  readonly goal: SelectionGoal
}

const rangeLength = (range: OffsetRange): number => range.end - range.start

const rangeToEdit = (range: OffsetRange, text: string): PieceTableEdit => ({
  from: range.start,
  to: range.end,
  text,
})

const selectionToEditTarget = (selection: ResolvedSelection): SelectionEditTarget => ({
  range: {
    start: selection.startOffset,
    end: selection.endOffset,
  },
  id: selection.id,
  goal: selection.goal,
})

const resolvedSelectionsToRanges = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): ResolvedSelection[] => {
  const normalized = normalizeSelectionSet(snapshot, set)
  return normalized.selections.map((selection) => resolveSelection(snapshot, selection))
}

const collapseSelectionsAfterEdits = (
  snapshot: PieceTableSnapshot,
  targets: readonly SelectionEditTarget[],
  text: string,
): SelectionSet<PieceTableAnchor> => {
  let delta = 0
  const selections: AnchorSelection[] = []

  for (const target of targets) {
    const range = target.range
    const caretOffset = range.start + delta + text.length
    selections.push(
      createAnchorSelection(snapshot, caretOffset, caretOffset, {
        cursorBias: 'left',
        goal: target.goal,
        id: target.id,
      }),
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
  const targets = resolvedSelectionsToRanges(snapshot, set).map(selectionToEditTarget)
  const edits = targets.map((target) => rangeToEdit(target.range, text))
  const nextSnapshot = applyBatchToPieceTable(snapshot, edits)

  return {
    snapshot: nextSnapshot,
    selections: collapseSelectionsAfterEdits(nextSnapshot, targets, text),
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
  const targets = normalized.selections
    .map((selection) => resolveSelection(snapshot, selection))
    .filter((selection) => !selection.collapsed)
    .map(selectionToEditTarget)
  const edits = targets.map((target) => rangeToEdit(target.range, ''))
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
    selections: collapseSelectionsAfterEdits(nextSnapshot, targets, ''),
    edits,
  }
}

export const backspaceSelections = (
  snapshot: PieceTableSnapshot,
  set: SelectionSet<PieceTableAnchor>,
): SelectionEditResult => {
  const normalized = normalizeSelectionSet(snapshot, set)
  const targets = normalized.selections
    .map((selection) => resolveSelection(snapshot, selection))
    .map((selection) => backspaceTargetForSelection(snapshot, selection))
    .filter((target): target is SelectionEditTarget => target !== null)
  const mergedTargets = mergeOffsetRangeTargets(targets)
  const edits = mergedTargets.map((target) => rangeToEdit(target.range, ''))
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
    selections: collapseSelectionsAfterEdits(nextSnapshot, mergedTargets, ''),
    edits,
  }
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

  const prefix = readPieceTableTextRange(snapshot, start, Math.min(end, start + tabSize))
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

const previousCodePointOffset = (snapshot: PieceTableSnapshot, offset: number): number => {
  if (offset <= 0) return 0
  if (offset < 2) return offset - 1

  const text = readPieceTableTextRange(snapshot, offset - 2, offset)
  const before = text.charCodeAt(0)
  const after = text.charCodeAt(1)
  const beforeIsHighSurrogate = before >= 0xd800 && before <= 0xdbff
  const afterIsLowSurrogate = after >= 0xdc00 && after <= 0xdfff
  if (beforeIsHighSurrogate && afterIsLowSurrogate) return offset - 2

  return offset - 1
}

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

const backspaceTargetForSelection = (
  snapshot: PieceTableSnapshot,
  selection: ResolvedSelection,
): SelectionEditTarget | null => {
  const range = backspaceRangeForSelection(snapshot, selection)
  if (!range) return null

  return {
    range,
    id: selection.id,
    goal: selection.goal,
  }
}

const lastItem = <T>(items: readonly T[]): T | null => {
  if (items.length === 0) return null
  return items[items.length - 1] ?? null
}

const mergeOffsetRangeTargets = (
  targets: readonly SelectionEditTarget[],
): SelectionEditTarget[] => {
  const sorted = targets.toSorted(
    (left, right) => left.range.start - right.range.start || left.range.end - right.range.end,
  )
  const merged: SelectionEditTarget[] = []

  for (const target of sorted) {
    const previous = lastItem(merged)
    if (!previous || target.range.start > previous.range.end) {
      merged.push(target)
      continue
    }

    merged[merged.length - 1] = {
      ...previous,
      range: {
        start: previous.range.start,
        end: Math.max(previous.range.end, target.range.end),
      },
    }
  }

  return merged
}
