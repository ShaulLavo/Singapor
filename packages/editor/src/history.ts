import type { Anchor as PieceTableAnchor, PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import type { SelectionSet } from './selections'

export type EditorHistoryEntry<TSnapshot, TSelectionState> = {
  readonly snapshot: TSnapshot
  readonly selections: TSelectionState
}

export type EditorHistoryStack<TSnapshot, TSelectionState> = {
  readonly entry: EditorHistoryEntry<TSnapshot, TSelectionState>
  readonly previous: EditorHistoryStack<TSnapshot, TSelectionState>
  readonly size: number
} | null

export type EditorHistory<TSnapshot, TSelectionState> = {
  readonly current: TSnapshot
  readonly selections: TSelectionState
  readonly undo: EditorHistoryStack<TSnapshot, TSelectionState>
  readonly redo: EditorHistoryStack<TSnapshot, TSelectionState>
}

export type PieceTableEditorHistory = EditorHistory<
  PieceTableSnapshot,
  SelectionSet<PieceTableAnchor>
>

export const createEditorHistory = <TSnapshot, TSelectionState>(
  current: TSnapshot,
  selections: TSelectionState,
): EditorHistory<TSnapshot, TSelectionState> => ({
  current,
  selections,
  undo: null,
  redo: null,
})

const pushHistoryEntry = <TSnapshot, TSelectionState>(
  stack: EditorHistoryStack<TSnapshot, TSelectionState>,
  entry: EditorHistoryEntry<TSnapshot, TSelectionState>,
): EditorHistoryStack<TSnapshot, TSelectionState> => ({
  entry,
  previous: stack,
  size: (stack?.size ?? 0) + 1,
})

export const commitEditorHistory = <TSnapshot, TSelectionState>(
  history: EditorHistory<TSnapshot, TSelectionState>,
  current: TSnapshot,
  selections: TSelectionState,
): EditorHistory<TSnapshot, TSelectionState> => ({
  current,
  selections,
  undo: pushHistoryEntry(history.undo, {
    snapshot: history.current,
    selections: history.selections,
  }),
  redo: null,
})

export const undoEditorHistory = <TSnapshot, TSelectionState>(
  history: EditorHistory<TSnapshot, TSelectionState>,
): EditorHistory<TSnapshot, TSelectionState> => {
  const previous = history.undo
  if (!previous) return history

  return {
    current: previous.entry.snapshot,
    selections: previous.entry.selections,
    undo: previous.previous,
    redo: pushHistoryEntry(history.redo, {
      snapshot: history.current,
      selections: history.selections,
    }),
  }
}

export const redoEditorHistory = <TSnapshot, TSelectionState>(
  history: EditorHistory<TSnapshot, TSelectionState>,
): EditorHistory<TSnapshot, TSelectionState> => {
  const next = history.redo
  if (!next) return history

  return {
    current: next.entry.snapshot,
    selections: next.entry.selections,
    undo: pushHistoryEntry(history.undo, {
      snapshot: history.current,
      selections: history.selections,
    }),
    redo: next.previous,
  }
}
