import {
  applyTextToSelections,
  backspaceSelections,
  createAnchorSelection,
  createSelectionSet,
  deleteSelections,
  indentSelections,
  markSelectionSetDirty,
  normalizeSelectionSet,
  outdentSelections,
  type AnchorSelection,
  type SelectionGoal,
  type SelectionSet,
} from './selections'
import {
  commitEditorHistory,
  createEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
  type PieceTableEditorHistory,
} from './history'
import type { EditorToken, TextEdit } from './tokens'
import {
  createDocumentTextSnapshot,
  defineLazyTextProperty,
  type DocumentTextSnapshot,
} from './documentTextSnapshot'
import type { Anchor as PieceTableAnchor, PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import { applyBatchToPieceTable } from './pieceTable/edits'
import { getPieceTableText, pieceTableSnapshotsHaveSameText } from './pieceTable/reads'
import { createPieceTableSnapshot } from './pieceTable/snapshot'

export type DocumentSessionChangeKind = 'edit' | 'selection' | 'undo' | 'redo' | 'none'

export type EditorTimingMeasurement = {
  readonly name: string
  readonly durationMs: number
}

export type DocumentSessionChange = {
  readonly kind: DocumentSessionChangeKind
  readonly edits: readonly TextEdit[]
  readonly snapshot: PieceTableSnapshot
  readonly selections: SelectionSet<PieceTableAnchor>
  readonly textSnapshot: DocumentTextSnapshot
  readonly text: string
  readonly tokens: readonly EditorToken[]
  readonly timings: readonly EditorTimingMeasurement[]
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly isDirty: boolean
}

export type DocumentSession = {
  applyText(text: string): DocumentSessionChange
  indentSelection(text: string): DocumentSessionChange
  outdentSelection(tabSize: number): DocumentSessionChange
  applyEdits(
    edits: readonly TextEdit[],
    options?: DocumentSessionApplyEditsOptions,
  ): DocumentSessionChange
  backspace(): DocumentSessionChange
  deleteSelection(): DocumentSessionChange
  undo(): DocumentSessionChange
  redo(): DocumentSessionChange
  setSelection(
    anchorOffset: number,
    headOffset?: number,
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange
  setSelections(
    selections: readonly DocumentSessionSelectionRange[],
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange
  addSelection(
    anchorOffset: number,
    headOffset?: number,
    options?: DocumentSessionSelectionOptions,
  ): DocumentSessionChange
  clearSecondarySelections(): DocumentSessionChange
  setTokens(tokens: readonly EditorToken[]): DocumentSessionChange
  adoptTokens(tokens: readonly EditorToken[]): DocumentSessionChange
  getText(): string
  getTextSnapshot(): DocumentTextSnapshot
  getTokens(): readonly EditorToken[]
  getSelections(): SelectionSet<PieceTableAnchor>
  getSnapshot(): PieceTableSnapshot
  canUndo(): boolean
  canRedo(): boolean
  isDirty(): boolean
  markClean(): void
}

export type DocumentSessionSelectionOptions = {
  readonly goal?: SelectionGoal
}

export type DocumentSessionSelectionRange = {
  readonly anchor: number
  readonly head?: number
  readonly goal?: SelectionGoal
}

export type DocumentSessionEditHistoryMode = 'record' | 'skip'

export type DocumentSessionEditSelection = DocumentSessionSelectionRange

export type DocumentSessionApplyEditsOptions = {
  readonly history?: DocumentSessionEditHistoryMode
  readonly selection?: DocumentSessionEditSelection
  readonly selections?: readonly DocumentSessionEditSelection[]
}

type CommitEditOptions = {
  readonly history: DocumentSessionEditHistoryMode
}

class PieceTableDocumentSession implements DocumentSession {
  private history: PieceTableEditorHistory
  private cleanSnapshot: PieceTableSnapshot
  private dirtyCacheSnapshot: PieceTableSnapshot
  private dirtyCacheValue = false
  private textSnapshot: DocumentTextSnapshot
  private tokens: readonly EditorToken[] = []
  private undoEdits: readonly (readonly TextEdit[])[]
  private redoEdits: readonly (readonly TextEdit[])[]

  public constructor(text: string) {
    const snapshot = createPieceTableSnapshot(text)
    const selections = createSelectionSet([createAnchorSelection(snapshot, snapshot.length)], true)
    this.history = createEditorHistory(snapshot, selections)
    this.cleanSnapshot = snapshot
    this.dirtyCacheSnapshot = snapshot
    this.textSnapshot = createDocumentTextSnapshot(snapshot, text)
    this.undoEdits = []
    this.redoEdits = []
  }

  public applyText(text: string): DocumentSessionChange {
    const start = nowMs()
    if (text.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyText', start)
    }

    const result = applyTextToSelections(this.history.current, this.history.selections, text)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      'session.applyText',
      start,
    )
  }

  public indentSelection(text: string): DocumentSessionChange {
    const start = nowMs()
    const result = indentSelections(this.history.current, this.history.selections, text)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      'session.indentSelection',
      start,
    )
  }

  public outdentSelection(tabSize: number): DocumentSessionChange {
    const start = nowMs()
    const result = outdentSelections(this.history.current, this.history.selections, tabSize)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      'session.outdentSelection',
      start,
    )
  }

  public applyEdits(
    edits: readonly TextEdit[],
    options: DocumentSessionApplyEditsOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    const normalizedEdits = normalizeTextEdits(edits)
    if (normalizedEdits.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyEdits', start)
    }

    const nextSnapshot = applyBatchToPieceTable(this.history.current, normalizedEdits)
    const effectiveEdits = normalizedEdits.filter(isEffectiveTextEdit)
    if (effectiveEdits.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyEdits', start)
    }

    const selections = this.selectionsAfterProgrammaticEdit(
      nextSnapshot,
      options.selection,
      options.selections,
    )
    return appendTiming(
      this.commitEdit(nextSnapshot, selections, effectiveEdits, {
        history: options.history ?? 'record',
      }),
      'session.applyEdits',
      start,
    )
  }

  public backspace(): DocumentSessionChange {
    const start = nowMs()
    const result = backspaceSelections(this.history.current, this.history.selections)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      'session.backspace',
      start,
    )
  }

  public deleteSelection(): DocumentSessionChange {
    const start = nowMs()
    const result = deleteSelections(this.history.current, this.history.selections)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      'session.delete',
      start,
    )
  }

  public undo(): DocumentSessionChange {
    const start = nowMs()
    const next = undoEditorHistory(this.history)
    if (next === this.history) {
      return appendTiming(this.createChange('none', []), 'session.undo', start)
    }

    const previousSnapshot = this.history.current
    this.history = next
    this.textSnapshot = createDocumentTextSnapshot(this.history.current)
    const edits = this.consumeUndoEdits(previousSnapshot)
    return appendTiming(this.createChange('undo', edits), 'session.undo', start)
  }

  public redo(): DocumentSessionChange {
    const start = nowMs()
    const next = redoEditorHistory(this.history)
    if (next === this.history) {
      return appendTiming(this.createChange('none', []), 'session.redo', start)
    }

    const previousSnapshot = this.history.current
    this.history = next
    this.textSnapshot = createDocumentTextSnapshot(this.history.current)
    const edits = this.consumeRedoEdits(previousSnapshot)
    return appendTiming(this.createChange('redo', edits), 'session.redo', start)
  }

  public setSelection(
    anchorOffset: number,
    headOffset = anchorOffset,
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    return this.setSelections([{ anchor: anchorOffset, head: headOffset }], options)
  }

  public setSelections(
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    this.history = {
      ...this.history,
      selections: this.createNormalizedSelectionSet(selections, options),
    }
    return appendTiming(this.createChange('selection', []), 'session.selection', start)
  }

  public addSelection(
    anchorOffset: number,
    headOffset = anchorOffset,
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    const nextSelection = this.createSelection(anchorOffset, headOffset, options)
    const selections = createSelectionSet([...this.history.selections.selections, nextSelection])
    this.history = {
      ...this.history,
      selections: normalizeSelectionSet(this.history.current, selections),
    }
    return appendTiming(this.createChange('selection', []), 'session.addSelection', start)
  }

  public clearSecondarySelections(): DocumentSessionChange {
    const start = nowMs()
    const normalized = normalizeSelectionSet(this.history.current, this.history.selections)
    const primary = normalized.selections[0]
    if (!primary || normalized.selections.length <= 1) {
      return appendTiming(this.createChange('none', []), 'session.clearSecondarySelections', start)
    }

    this.history = {
      ...this.history,
      selections: createSelectionSet([primary], true, this.history.current),
    }
    return appendTiming(
      this.createChange('selection', []),
      'session.clearSecondarySelections',
      start,
    )
  }

  public setTokens(tokens: readonly EditorToken[]): DocumentSessionChange {
    return this.adoptTokens(tokens)
  }

  public adoptTokens(tokens: readonly EditorToken[]): DocumentSessionChange {
    const start = nowMs()
    this.tokens = tokens
    return appendTiming(this.createChange('none', []), 'session.setTokens', start)
  }

  public getText(): string {
    return this.textSnapshot.getText()
  }

  public getTextSnapshot(): DocumentTextSnapshot {
    return this.textSnapshot
  }

  public getTokens(): readonly EditorToken[] {
    return this.tokens
  }

  public getSelections(): SelectionSet<PieceTableAnchor> {
    return this.history.selections
  }

  public getSnapshot(): PieceTableSnapshot {
    return this.history.current
  }

  public canUndo(): boolean {
    return this.history.undo !== null
  }

  public canRedo(): boolean {
    return this.history.redo !== null
  }

  public isDirty(): boolean {
    const snapshot = this.history.current
    if (this.dirtyCacheSnapshot === snapshot) return this.dirtyCacheValue

    const dirty = !pieceTableSnapshotsHaveSameText(snapshot, this.cleanSnapshot)
    this.dirtyCacheSnapshot = snapshot
    this.dirtyCacheValue = dirty
    return dirty
  }

  public markClean(): void {
    this.cleanSnapshot = this.history.current
    this.dirtyCacheSnapshot = this.history.current
    this.dirtyCacheValue = false
  }

  private commitEdit(
    snapshot: PieceTableSnapshot,
    selections: SelectionSet<PieceTableAnchor>,
    edits: readonly TextEdit[],
    options: CommitEditOptions = { history: 'record' },
  ): DocumentSessionChange {
    if (edits.length === 0) return this.createChange('none', [])

    if (options.history === 'record') {
      this.recordEditHistory(edits)
      this.history = commitEditorHistory(this.history, snapshot, selections)
    } else {
      this.history = { ...this.history, current: snapshot, selections }
    }

    this.textSnapshot = createDocumentTextSnapshot(snapshot)
    return this.createChange('edit', edits)
  }

  private selectionsAfterProgrammaticEdit(
    snapshot: PieceTableSnapshot,
    selection: DocumentSessionEditSelection | undefined,
    selections: readonly DocumentSessionEditSelection[] | undefined,
  ): SelectionSet<PieceTableAnchor> {
    if (selections) return this.createNormalizedSelectionSetForSnapshot(snapshot, selections, {})

    if (selection) {
      const anchor = selection.anchor
      const head = selection.head ?? selection.anchor
      return createSelectionSet([createAnchorSelection(snapshot, anchor, head)], true, snapshot)
    }

    return markSelectionSetDirty(this.history.selections)
  }

  private createNormalizedSelectionSet(
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions,
  ): SelectionSet<PieceTableAnchor> {
    const anchorSelections = selections.map((selection) => {
      const head = selection.head ?? selection.anchor
      return this.createSelection(selection.anchor, head, {
        goal: selection.goal ?? options.goal,
      })
    })
    const set = createSelectionSet(anchorSelections)
    return normalizeSelectionSet(this.history.current, set)
  }

  private createNormalizedSelectionSetForSnapshot(
    snapshot: PieceTableSnapshot,
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions,
  ): SelectionSet<PieceTableAnchor> {
    const anchorSelections = selections.map((selection) => {
      const head = selection.head ?? selection.anchor
      return createAnchorSelection(snapshot, selection.anchor, head, {
        goal: selection.goal ?? options.goal,
      })
    })
    const set = createSelectionSet(anchorSelections)
    return normalizeSelectionSet(snapshot, set)
  }

  private createSelection(
    anchorOffset: number,
    headOffset: number,
    options: DocumentSessionSelectionOptions,
  ): AnchorSelection {
    return createAnchorSelection(this.history.current, anchorOffset, headOffset, {
      goal: options.goal,
    })
  }

  private recordEditHistory(edits: readonly TextEdit[]): void {
    const undoEdits = invertTextEdits(this.history.current, edits)
    this.undoEdits = [...this.undoEdits, undoEdits]
    this.redoEdits = []
  }

  private consumeUndoEdits(previousSnapshot: PieceTableSnapshot): readonly TextEdit[] {
    const edits = this.undoEdits.at(-1) ?? []
    this.undoEdits = this.undoEdits.slice(0, -1)
    this.redoEdits = [...this.redoEdits, invertTextEdits(previousSnapshot, edits)]
    return edits
  }

  private consumeRedoEdits(previousSnapshot: PieceTableSnapshot): readonly TextEdit[] {
    const edits = this.redoEdits.at(-1) ?? []
    this.redoEdits = this.redoEdits.slice(0, -1)
    this.undoEdits = [...this.undoEdits, invertTextEdits(previousSnapshot, edits)]
    return edits
  }

  private createChange(
    kind: DocumentSessionChangeKind,
    edits: readonly TextEdit[],
  ): DocumentSessionChange {
    return createDocumentSessionChange({
      kind,
      edits,
      snapshot: this.history.current,
      selections: this.history.selections,
      textSnapshot: this.textSnapshot,
      tokens: this.tokens,
      timings: [],
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      isDirty: this.isDirty(),
    })
  }
}

class StaticDocumentSession implements DocumentSession {
  private snapshot: PieceTableSnapshot
  private textSnapshot: DocumentTextSnapshot
  private selections: SelectionSet<PieceTableAnchor>
  private tokens: readonly EditorToken[] = []

  public constructor(text: string) {
    this.snapshot = createPieceTableSnapshot(text)
    this.textSnapshot = createDocumentTextSnapshot(this.snapshot, text)
    this.selections = createSelectionSet(
      [createAnchorSelection(this.snapshot, this.snapshot.length)],
      true,
      this.snapshot,
    )
  }

  public applyText(_text: string): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public indentSelection(_text: string): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public outdentSelection(_tabSize: number): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public applyEdits(
    edits: readonly TextEdit[],
    options: DocumentSessionApplyEditsOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    const normalizedEdits = normalizeTextEdits(edits)
    if (normalizedEdits.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyEdits', start)
    }

    const nextSnapshot = applyBatchToPieceTable(this.snapshot, normalizedEdits)
    const effectiveEdits = normalizedEdits.filter(isEffectiveTextEdit)
    if (effectiveEdits.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyEdits', start)
    }

    this.snapshot = nextSnapshot
    this.textSnapshot = createDocumentTextSnapshot(nextSnapshot)
    this.selections = this.selectionsAfterProgrammaticEdit(nextSnapshot, options)
    return appendTiming(this.createChange('edit', effectiveEdits), 'session.applyEdits', start)
  }

  public backspace(): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public deleteSelection(): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public undo(): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public redo(): DocumentSessionChange {
    return this.createChange('none', [])
  }

  public setSelection(
    anchorOffset: number,
    headOffset = anchorOffset,
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    return this.setSelections([{ anchor: anchorOffset, head: headOffset }], options)
  }

  public setSelections(
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    this.selections = this.createNormalizedSelectionSet(selections, options)
    return appendTiming(this.createChange('selection', []), 'session.selection', start)
  }

  public addSelection(
    anchorOffset: number,
    headOffset = anchorOffset,
    options: DocumentSessionSelectionOptions = {},
  ): DocumentSessionChange {
    const start = nowMs()
    const nextSelection = this.createSelection(anchorOffset, headOffset, options)
    this.selections = normalizeSelectionSet(
      this.snapshot,
      createSelectionSet([...this.selections.selections, nextSelection]),
    )
    return appendTiming(this.createChange('selection', []), 'session.addSelection', start)
  }

  public clearSecondarySelections(): DocumentSessionChange {
    const start = nowMs()
    const normalized = normalizeSelectionSet(this.snapshot, this.selections)
    const primary = normalized.selections[0]
    if (!primary || normalized.selections.length <= 1) {
      return appendTiming(this.createChange('none', []), 'session.clearSecondarySelections', start)
    }

    this.selections = createSelectionSet([primary], true, this.snapshot)
    return appendTiming(
      this.createChange('selection', []),
      'session.clearSecondarySelections',
      start,
    )
  }

  public setTokens(tokens: readonly EditorToken[]): DocumentSessionChange {
    return this.adoptTokens(tokens)
  }

  public adoptTokens(tokens: readonly EditorToken[]): DocumentSessionChange {
    const start = nowMs()
    this.tokens = tokens
    return appendTiming(this.createChange('none', []), 'session.setTokens', start)
  }

  public getText(): string {
    return this.textSnapshot.getText()
  }

  public getTextSnapshot(): DocumentTextSnapshot {
    return this.textSnapshot
  }

  public getTokens(): readonly EditorToken[] {
    return this.tokens
  }

  public getSelections(): SelectionSet<PieceTableAnchor> {
    return this.selections
  }

  public getSnapshot(): PieceTableSnapshot {
    return this.snapshot
  }

  public canUndo(): boolean {
    return false
  }

  public canRedo(): boolean {
    return false
  }

  public isDirty(): boolean {
    return false
  }

  public markClean(): void {
    return
  }

  private createNormalizedSelectionSet(
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions,
  ): SelectionSet<PieceTableAnchor> {
    const anchorSelections = selections.map((selection) => {
      const head = selection.head ?? selection.anchor
      return this.createSelection(selection.anchor, head, {
        goal: selection.goal ?? options.goal,
      })
    })
    return normalizeSelectionSet(this.snapshot, createSelectionSet(anchorSelections))
  }

  private createSelection(
    anchorOffset: number,
    headOffset: number,
    options: DocumentSessionSelectionOptions,
  ): AnchorSelection {
    return createAnchorSelection(this.snapshot, anchorOffset, headOffset, {
      goal: options.goal,
    })
  }

  private selectionsAfterProgrammaticEdit(
    snapshot: PieceTableSnapshot,
    options: DocumentSessionApplyEditsOptions,
  ): SelectionSet<PieceTableAnchor> {
    if (options.selections) {
      return this.createNormalizedSelectionSetForSnapshot(snapshot, options.selections, {})
    }
    if (options.selection) {
      return this.createNormalizedSelectionSetForSnapshot(snapshot, [options.selection], {})
    }

    return markSelectionSetDirty(this.selections)
  }

  private createNormalizedSelectionSetForSnapshot(
    snapshot: PieceTableSnapshot,
    selections: readonly DocumentSessionSelectionRange[],
    options: DocumentSessionSelectionOptions,
  ): SelectionSet<PieceTableAnchor> {
    const anchorSelections = selections.map((selection) => {
      const head = selection.head ?? selection.anchor
      return createAnchorSelection(snapshot, selection.anchor, head, {
        goal: selection.goal ?? options.goal,
      })
    })
    return normalizeSelectionSet(snapshot, createSelectionSet(anchorSelections))
  }

  private createChange(
    kind: DocumentSessionChangeKind,
    edits: readonly TextEdit[],
  ): DocumentSessionChange {
    return createDocumentSessionChange({
      kind,
      edits,
      snapshot: this.snapshot,
      selections: this.selections,
      textSnapshot: this.textSnapshot,
      tokens: this.tokens,
      timings: [],
      canUndo: false,
      canRedo: false,
      isDirty: false,
    })
  }
}

export function createDocumentSession(text: string): DocumentSession {
  return new PieceTableDocumentSession(text)
}

export function createStaticDocumentSession(text: string): DocumentSession {
  return new StaticDocumentSession(text)
}

type DocumentSessionChangeFields = Omit<DocumentSessionChange, 'text'>

function createDocumentSessionChange(fields: DocumentSessionChangeFields): DocumentSessionChange {
  return defineLazyTextProperty({ ...fields })
}

export function documentSessionChangeTextSnapshot(
  change: DocumentSessionChange,
): DocumentTextSnapshot {
  const textSnapshot = (change as { readonly textSnapshot?: DocumentTextSnapshot }).textSnapshot
  if (textSnapshot) return textSnapshot
  return createDocumentTextSnapshot(change.snapshot, change.text)
}

export function withDocumentSessionChangeTimings(
  change: DocumentSessionChange,
  timings: readonly EditorTimingMeasurement[],
): DocumentSessionChange {
  return createDocumentSessionChange({
    kind: change.kind,
    edits: change.edits,
    snapshot: change.snapshot,
    selections: change.selections,
    textSnapshot: documentSessionChangeTextSnapshot(change),
    tokens: change.tokens,
    timings,
    canUndo: change.canUndo,
    canRedo: change.canRedo,
    isDirty: change.isDirty,
  })
}

function normalizeTextEdits(edits: readonly TextEdit[]): readonly TextEdit[] {
  return edits
    .map((edit) => ({ from: edit.from, to: edit.to, text: edit.text }))
    .toSorted((left, right) => left.from - right.from || left.to - right.to)
}

function isEffectiveTextEdit(edit: TextEdit): boolean {
  return edit.from !== edit.to || edit.text.length > 0
}

function invertTextEdits(
  snapshot: PieceTableSnapshot,
  edits: readonly TextEdit[],
): readonly TextEdit[] {
  let delta = 0
  const inverse: TextEdit[] = []
  const sorted = edits.toSorted((left, right) => left.from - right.from || left.to - right.to)

  for (const edit of sorted) {
    const from = edit.from + delta
    const to = from + edit.text.length
    inverse.push({
      from,
      to,
      text: getPieceTableText(snapshot, edit.from, edit.to),
    })
    delta += edit.text.length - (edit.to - edit.from)
  }

  return inverse
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function appendTiming(
  change: DocumentSessionChange,
  name: string,
  startMs: number,
): DocumentSessionChange {
  return withDocumentSessionChangeTimings(change, [
    ...change.timings,
    { name, durationMs: nowMs() - startMs },
  ])
}
