import { describe, expect, it } from 'vitest'
import {
  createPieceTableSnapshot,
  deleteFromPieceTable,
  materializePieceTableFullText,
} from '../src/public/document'
import {
  createAnchorSelection,
  createSelectionSet,
  normalizeSelectionSet,
  resolveSelection,
  SelectionGoal,
} from '../src/selections'
import {
  applyTextToSelections,
  backspaceSelections,
  deleteSelections,
} from '../src/documentSelectionEdits'
import {
  commitEditorHistory,
  createEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
} from '../src/history'

describe('selections', () => {
  it('creates anchor-backed selections with resolved anchor and head offsets', () => {
    const snapshot = createPieceTableSnapshot('abcdef')
    const selection = createAnchorSelection(snapshot, 4, 2, {
      id: 'selection-a',
      goal: SelectionGoal.horizontal(24),
    })
    const resolved = resolveSelection(snapshot, selection)

    expect(resolved).toMatchObject({
      id: 'selection-a',
      startOffset: 2,
      endOffset: 4,
      anchorOffset: 4,
      headOffset: 2,
      reversed: true,
      collapsed: false,
      goal: { kind: 'horizontal', x: 24 },
      liveness: 'live',
    })
  })

  it('normalizes selections by sorting and merging touching or overlapping ranges', () => {
    const snapshot = createPieceTableSnapshot('abcdef')
    const set = createSelectionSet([
      createAnchorSelection(snapshot, 4, 6, { id: 'b' }),
      createAnchorSelection(snapshot, 1, 3, { id: 'a', goal: SelectionGoal.horizontal(12) }),
      createAnchorSelection(snapshot, 3, 4, { id: 'touching' }),
    ])
    const normalized = normalizeSelectionSet(snapshot, set)

    expect(normalized.normalized).toBe(true)
    expect(normalized.selections).toHaveLength(1)

    const resolved = resolveSelection(snapshot, normalized.selections[0]!)
    expect(resolved).toMatchObject({
      id: 'a',
      startOffset: 1,
      endOffset: 6,
      reversed: false,
      goal: { kind: 'none' },
    })
  })

  it('renormalizes stale normalized selections against a newer snapshot', () => {
    const snapshot = createPieceTableSnapshot('abcd')
    const set = createSelectionSet([
      createAnchorSelection(snapshot, 1, 2, { id: 'first' }),
      createAnchorSelection(snapshot, 3, 4, { id: 'second' }),
    ])
    const normalized = normalizeSelectionSet(snapshot, set)
    const edited = deleteFromPieceTable(snapshot, 2, 1)

    const result = applyTextToSelections(edited, normalized, 'X')

    expect(materializePieceTableFullText(result.snapshot)).toBe('aX')
    expect(result.edits).toEqual([{ from: 1, to: 3, text: 'X' }])
  })

  it('applies multi-selection text edits against the original snapshot', () => {
    const snapshot = createPieceTableSnapshot('abcdef')
    const set = createSelectionSet([
      createAnchorSelection(snapshot, 1, 2),
      createAnchorSelection(snapshot, 4, 6),
    ])

    const result = applyTextToSelections(snapshot, set, 'X')

    expect(materializePieceTableFullText(result.snapshot)).toBe('aXcdX')
    expect(result.edits).toEqual([
      { from: 1, to: 2, text: 'X' },
      { from: 4, to: 6, text: 'X' },
    ])
    expect(
      result.selections.selections.map((selection) => resolveSelection(result.snapshot, selection)),
    ).toMatchObject([
      { startOffset: 2, endOffset: 2 },
      { startOffset: 5, endOffset: 5 },
    ])
  })

  it('keeps collapsed cursors after inserted text for repeated typing', () => {
    const snapshot = createPieceTableSnapshot('abcdef')
    const set = createSelectionSet([createAnchorSelection(snapshot, 3)], true)

    const first = applyTextToSelections(snapshot, set, 'X')
    const second = applyTextToSelections(first.snapshot, first.selections, 'Y')

    expect(materializePieceTableFullText(second.snapshot)).toBe('abcXYdef')
    expect(resolveSelection(second.snapshot, second.selections.selections[0]!)).toMatchObject({
      startOffset: 5,
      endOffset: 5,
    })
  })

  it('backspaces collapsed cursors by code point', () => {
    const snapshot = createPieceTableSnapshot('a😀b')
    const set = createSelectionSet([createAnchorSelection(snapshot, 3)])

    const result = backspaceSelections(snapshot, set)

    expect(materializePieceTableFullText(result.snapshot)).toBe('ab')
    expect(result.edits).toEqual([{ from: 1, to: 3, text: '' }])
    expect(resolveSelection(result.snapshot, result.selections.selections[0]!)).toMatchObject({
      startOffset: 1,
      endOffset: 1,
    })
  })

  it('preserves cursors on no-op backspace at document start', () => {
    const snapshot = createPieceTableSnapshot('abc')
    const set = createSelectionSet([createAnchorSelection(snapshot, 0)])

    const result = backspaceSelections(snapshot, set)

    expect(result.snapshot).toBe(snapshot)
    expect(result.edits).toEqual([])
    expect(result.selections.selections).toHaveLength(1)
    expect(resolveSelection(result.snapshot, result.selections.selections[0]!)).toMatchObject({
      startOffset: 0,
      endOffset: 0,
    })
  })

  it('deletes selected ranges without deleting collapsed cursors', () => {
    const snapshot = createPieceTableSnapshot('abcdef')
    const set = createSelectionSet([
      createAnchorSelection(snapshot, 1, 3),
      createAnchorSelection(snapshot, 5),
    ])

    const result = deleteSelections(snapshot, set)

    expect(materializePieceTableFullText(result.snapshot)).toBe('adef')
    expect(result.edits).toEqual([{ from: 1, to: 3, text: '' }])
    expect(resolveSelection(result.snapshot, result.selections.selections[0]!)).toMatchObject({
      startOffset: 1,
      endOffset: 1,
    })
  })

  it('deletes selected ranges before backspacing collapsed cursors', () => {
    const snapshot = createPieceTableSnapshot('abcdef')
    const set = createSelectionSet([
      createAnchorSelection(snapshot, 1, 3),
      createAnchorSelection(snapshot, 5),
    ])

    const result = backspaceSelections(snapshot, set)

    expect(materializePieceTableFullText(result.snapshot)).toBe('adf')
    expect(result.edits).toEqual([
      { from: 1, to: 3, text: '' },
      { from: 4, to: 5, text: '' },
    ])
  })

  it('keeps snapshots and selections together in undo and redo history', () => {
    const snapshot = createPieceTableSnapshot('abc')
    const selections = createSelectionSet([createAnchorSelection(snapshot, 3)], true)
    const history = createEditorHistory(snapshot, selections)
    const edit = applyTextToSelections(snapshot, selections, '!')
    const committed = commitEditorHistory(history, edit.snapshot, edit.selections)
    const undone = undoEditorHistory(committed)
    const redone = redoEditorHistory(undone)

    expect(materializePieceTableFullText(committed.current)).toBe('abc!')
    expect(committed.undo?.size).toBe(1)
    expect(materializePieceTableFullText(undone.current)).toBe('abc')
    expect(undone.undo).toBeNull()
    expect(undone.redo?.size).toBe(1)
    expect(materializePieceTableFullText(redone.current)).toBe('abc!')
    expect(redone.undo?.size).toBe(1)
    expect(redone.redo).toBeNull()
    expect(redone.selections.selections).toHaveLength(1)
  })
})
