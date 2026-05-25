import {
  applyTextToSelections,
  backspaceSelections,
  createAnchorSelection,
  createSelectionIdFactory,
  createSelectionSet,
  deleteSelections,
  indentSelections,
  markSelectionSetDirty,
  normalizeSelectionSet,
  outdentSelections,
  type AnchorSelection,
  type SelectionIdFactory,
  type SelectionGoal,
  type SelectionSet,
} from './selections'
import {
  commitEditorHistory,
  createEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
  type EditorHistory,
} from './history'
import type { TextEdit } from './tokens'
import { createDocumentTextSnapshot, type DocumentTextSnapshot } from './documentTextSnapshot'
import type { Anchor as PieceTableAnchor, PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import { applyBatchToPieceTable } from './pieceTable/edits'
import { readPieceTableTextRange, pieceTableSnapshotsHaveSameText } from './pieceTable/reads'
import { createPieceTableSnapshot } from './pieceTable/snapshot'

export type DocumentSessionChangeKind = 'edit' | 'selection' | 'undo' | 'redo' | 'none'

export type EditorTimingMeasurement = {
  readonly name: string
  readonly durationMs: number
}

export type DocumentSessionChange = {
  readonly kind: DocumentSessionChangeKind
  readonly edits: readonly TextEdit[]
  readonly transaction: DocumentTransaction | null
  readonly snapshot: PieceTableSnapshot
  readonly selections: SelectionSet<PieceTableAnchor>
  readonly textSnapshot: DocumentTextSnapshot
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
  materializeFullText(): string
  getTextSnapshot(): DocumentTextSnapshot
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

export type DocumentTransactionMetadata = {
  readonly source: 'keyboard' | 'programmatic' | 'history'
  readonly intent:
    | 'insert-text'
    | 'indent'
    | 'outdent'
    | 'backspace'
    | 'delete'
    | 'programmatic-edit'
    | 'undo'
    | 'redo'
  readonly undoGroup?: string
}

export type DocumentTransaction = {
  readonly edits: readonly TextEdit[]
  readonly inverseEdits: readonly TextEdit[]
  readonly snapshotBefore: PieceTableSnapshot
  readonly snapshotAfter: PieceTableSnapshot
  readonly selectionBefore: SelectionSet<PieceTableAnchor>
  readonly selectionAfter: SelectionSet<PieceTableAnchor>
  readonly metadata: DocumentTransactionMetadata
}

type CommitEditOptions = {
  readonly history: DocumentSessionEditHistoryMode
  readonly metadata: DocumentTransactionMetadata
}

type DocumentHistory = EditorHistory<
  PieceTableSnapshot,
  SelectionSet<PieceTableAnchor>,
  DocumentTransaction
>

class PieceTableDocumentSession implements DocumentSession {
  private readonly createSelectionId: SelectionIdFactory = createSelectionIdFactory()
  private history: DocumentHistory
  private cleanSnapshot: PieceTableSnapshot
  private dirtyCacheSnapshot: PieceTableSnapshot
  private dirtyCacheValue = false
  private textSnapshot: DocumentTextSnapshot

  public constructor(text: string) {
    const snapshot = createPieceTableSnapshot(text)
    const selections = createSelectionSet(
      [
        createAnchorSelection(snapshot, snapshot.length, snapshot.length, {
          idFactory: this.createSelectionId,
        }),
      ],
      true,
    )
    this.history = createEditorHistory<
      PieceTableSnapshot,
      SelectionSet<PieceTableAnchor>,
      DocumentTransaction
    >(snapshot, selections)
    this.cleanSnapshot = snapshot
    this.dirtyCacheSnapshot = snapshot
    this.textSnapshot = createDocumentTextSnapshot(snapshot, text)
  }

  public applyText(text: string): DocumentSessionChange {
    const start = nowMs()
    if (text.length === 0) {
      return appendTiming(this.createChange('none', []), 'session.applyText', start)
    }

    const result = applyTextToSelections(this.history.current, this.history.selections, text)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'insert-text' },
      }),
      'session.applyText',
      start,
    )
  }

  public indentSelection(text: string): DocumentSessionChange {
    const start = nowMs()
    const result = indentSelections(this.history.current, this.history.selections, text)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'indent' },
      }),
      'session.indentSelection',
      start,
    )
  }

  public outdentSelection(tabSize: number): DocumentSessionChange {
    const start = nowMs()
    const result = outdentSelections(this.history.current, this.history.selections, tabSize)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'outdent' },
      }),
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
        metadata: { source: 'programmatic', intent: 'programmatic-edit' },
      }),
      'session.applyEdits',
      start,
    )
  }

  public backspace(): DocumentSessionChange {
    const start = nowMs()
    const result = backspaceSelections(this.history.current, this.history.selections)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'backspace' },
      }),
      'session.backspace',
      start,
    )
  }

  public deleteSelection(): DocumentSessionChange {
    const start = nowMs()
    const result = deleteSelections(this.history.current, this.history.selections)
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits, {
        history: 'record',
        metadata: { source: 'keyboard', intent: 'delete' },
      }),
      'session.delete',
      start,
    )
  }

  public undo(): DocumentSessionChange {
    const start = nowMs()
    const transaction = this.history.undo?.entry.transaction ?? null
    const next = undoEditorHistory(this.history)
    if (next === this.history) {
      return appendTiming(this.createChange('none', []), 'session.undo', start)
    }

    this.history = next
    this.textSnapshot = createDocumentTextSnapshot(this.history.current)
    return appendTiming(
      this.createChange('undo', transaction?.inverseEdits ?? [], transaction),
      'session.undo',
      start,
    )
  }

  public redo(): DocumentSessionChange {
    const start = nowMs()
    const transaction = this.history.redo?.entry.transaction ?? null
    const next = redoEditorHistory(this.history)
    if (next === this.history) {
      return appendTiming(this.createChange('none', []), 'session.redo', start)
    }

    this.history = next
    this.textSnapshot = createDocumentTextSnapshot(this.history.current)
    return appendTiming(
      this.createChange('redo', transaction?.edits ?? [], transaction),
      'session.redo',
      start,
    )
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

  public materializeFullText(): string {
    return this.textSnapshot.materializeFullText()
  }

  public getTextSnapshot(): DocumentTextSnapshot {
    return this.textSnapshot
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
    options: CommitEditOptions,
  ): DocumentSessionChange {
    if (edits.length === 0) return this.createChange('none', [])

    const transaction = this.createTransaction(snapshot, selections, edits, options.metadata)
    if (options.history === 'record') {
      this.history = commitEditorHistory(this.history, snapshot, selections, transaction)
    } else {
      this.history = { ...this.history, current: snapshot, selections }
    }

    this.textSnapshot = createDocumentTextSnapshot(snapshot)
    return this.createChange('edit', edits, transaction)
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
      const anchorSelection = createAnchorSelection(snapshot, anchor, head, {
        idFactory: this.createSelectionId,
      })
      return createSelectionSet([anchorSelection], true, snapshot)
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
        idFactory: this.createSelectionId,
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
      idFactory: this.createSelectionId,
    })
  }

  private createTransaction(
    snapshot: PieceTableSnapshot,
    selections: SelectionSet<PieceTableAnchor>,
    edits: readonly TextEdit[],
    metadata: DocumentTransactionMetadata,
  ): DocumentTransaction {
    return {
      edits,
      inverseEdits: invertTextEdits(this.history.current, edits),
      snapshotBefore: this.history.current,
      snapshotAfter: snapshot,
      selectionBefore: this.history.selections,
      selectionAfter: selections,
      metadata,
    }
  }

  private createChange(
    kind: DocumentSessionChangeKind,
    edits: readonly TextEdit[],
    transaction: DocumentTransaction | null = null,
  ): DocumentSessionChange {
    return createDocumentSessionChange({
      kind,
      edits,
      transaction,
      snapshot: this.history.current,
      selections: this.history.selections,
      textSnapshot: this.textSnapshot,
      timings: [],
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      isDirty: this.isDirty(),
    })
  }
}

class StaticDocumentSession implements DocumentSession {
  private readonly createSelectionId: SelectionIdFactory = createSelectionIdFactory()
  private snapshot: PieceTableSnapshot
  private textSnapshot: DocumentTextSnapshot
  private selections: SelectionSet<PieceTableAnchor>

  public constructor(text: string) {
    this.snapshot = createPieceTableSnapshot(text)
    this.textSnapshot = createDocumentTextSnapshot(this.snapshot, text)
    this.selections = createSelectionSet(
      [
        createAnchorSelection(this.snapshot, this.snapshot.length, this.snapshot.length, {
          idFactory: this.createSelectionId,
        }),
      ],
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

  public materializeFullText(): string {
    return this.textSnapshot.materializeFullText()
  }

  public getTextSnapshot(): DocumentTextSnapshot {
    return this.textSnapshot
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
      idFactory: this.createSelectionId,
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
        idFactory: this.createSelectionId,
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
      transaction: null,
      snapshot: this.snapshot,
      selections: this.selections,
      textSnapshot: this.textSnapshot,
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

type DocumentSessionChangeFields = DocumentSessionChange

function createDocumentSessionChange(fields: DocumentSessionChangeFields): DocumentSessionChange {
  return { ...fields }
}

export function documentSessionChangeTextSnapshot(
  change: DocumentSessionChange,
): DocumentTextSnapshot {
  return change.textSnapshot
}

export function withDocumentSessionChangeTimings(
  change: DocumentSessionChange,
  timings: readonly EditorTimingMeasurement[],
): DocumentSessionChange {
  return createDocumentSessionChange({
    kind: change.kind,
    edits: change.edits,
    transaction: change.transaction,
    snapshot: change.snapshot,
    selections: change.selections,
    textSnapshot: documentSessionChangeTextSnapshot(change),
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
      text: readPieceTableTextRange(snapshot, edit.from, edit.to),
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
