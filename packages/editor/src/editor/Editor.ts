import {
  documentSessionChangeTextSnapshot,
  type DocumentSession,
  type DocumentSessionChange,
} from '../documentSession'
import { projectSyntaxFoldsThroughLineEdit } from './folds'
import { EditorFoldState } from './foldState'
import { EditorKeymapController } from './keymap'
import { EditorBlockSurfaceController } from './blockSurfaceController'
import { InputSelectionController } from './inputSelectionController'
import { EditorSyntaxController } from './syntaxController'
import { EditorSecondaryWorkScheduler } from './secondaryWorkScheduler'
import { appendTiming, nowMs } from './timing'
import { copyTokenProjectionMetadata, projectTokensThroughEdit } from './tokenProjection'
import { measureEditorPerformance } from './performanceDiagnostics'
import type { EditorCommandContext, EditorCommandId } from './commands'
import { normalizeEditorEditInput } from './editInput'
import { EditorCommandRouter } from './commandRouter'
import { getHighlightRegistry, nextEditorHighlightPrefix, recordEditorMountTiming } from './runtime'
import {
  DOCUMENT_START_SCROLL_POSITION,
  normalizeScrollOffset,
  preservedScrollPosition,
} from './scroll'
import {
  normalizeEditorDocumentMode,
  normalizeEditorSelectionSyncMode,
  type ResetOwnedDocumentOptions,
} from './editorDocument'
import { EditorDocumentController } from './documentController'
import {
  removeArrayItem,
  viewContributionKindForChange,
  type SessionChangeOptions,
} from './editorUtils'
import { EDITOR_FIND_FEATURE_ID, type EditorFindFeature } from './findFeature'
import { foldCandidateAtLocation, type FoldOperation } from './foldOperations'
import { groupedRangeDecorations, sameEditorRangeDecorations } from './rangeDecorations'
import { selectionRevealOffset, type EditorSelectionRevealTarget } from './selectionReveal'
import { syncTextEdit } from './textEdits'
import type {
  EditorDocumentMode,
  EditorEditInput,
  EditorEditOptions,
  EditorEditability,
  EditorOptions,
  EditorOpenDocumentOptions,
  EditorRangeDecoration,
  EditorScrollPosition,
  EditorSetTextOptions,
  EditorSessionOptions,
  EditorState,
  EditorSyntaxStatus,
} from './types'
import { EditorViewContributionController } from './viewContributions'
import type { FoldMap } from '../foldMap'
import { normalizeTabSize } from '../displayTransforms'
import type { InjectedTextRow } from '../displayTransforms'
import { offsetToPoint } from '../pieceTable/positions'
import {
  EditorPluginHost,
  type EditorCommandHandler,
  type EditorDisposable,
  type EditorFeatureContribution,
  type EditorFeatureContributionContext,
  type EditorFeatureContributionProvider,
  type EditorInjectedTextRowProviderContext,
  type EditorOverlaySide,
  type EditorPlugin,
  type EditorViewContribution,
  type EditorViewContributionContext,
  type EditorViewContributionProvider,
  type EditorViewContributionUpdateKind,
  type EditorViewSnapshot,
} from '../plugins'
import { resolveSelection } from '../selections'
import { type EditorSyntaxLanguageId } from '../syntax/session'
import type { EditorSyntaxRange } from '../syntax/session'
import {
  parseMergeConflicts,
  resolveMergeConflict as resolveMergeConflictText,
  type MergeConflictRegion,
  type MergeConflictResolution,
} from '../mergeConflicts'
import type { FoldRange } from '../syntax/session'
import type { EditorTheme } from '../theme'
import { editorThemesEqual, mergeEditorThemes } from '../theme'
import type { EditorDocument, EditorToken, TextEdit } from '../tokens'
import {
  createStringTextSnapshot,
  defineLazyFullTextProperty,
  type TextSnapshot,
} from '../documentTextSnapshot'
import { clamp } from '../style-utils'
import {
  VirtualizedTextView,
  type HiddenCharactersMode,
  type VirtualizedFoldMarker,
  type VirtualizedTextRowDecoration,
} from '../virtualization/virtualizedTextView'

const RAPID_INPUT_SECONDARY_WORK_DELAY_MS = 150
const RAPID_INPUT_TIMING_NAMES = new Set([
  'input.beforeinput',
  'input.keydownFallback',
  'input.backspace',
  'input.delete',
])
const VISIBLE_SYNTAX_OVERSCAN_CHARS = 20_000
const VISIBLE_SYNTAX_TRAILING_CHARS = 50_000
const VISIBLE_SYNTAX_LEAD_CHARS = 250_000
const VISIBLE_SYNTAX_MAX_LEAD_CHARS = 750_000
const VISIBLE_SYNTAX_SCROLL_DELAY_MS = 16
const BACKGROUND_SYNTAX_WARM_DELAY_MS = 80

type SyntaxScrollDirection = -1 | 0 | 1

export class Editor {
  private readonly container: HTMLElement
  private readonly view: VirtualizedTextView
  private readonly foldState: EditorFoldState
  private readonly el: HTMLDivElement
  private lastSyntaxScrollTop: number | null = null
  private syntaxScrollDeltaPx = 0
  private syntaxScrollDirection: SyntaxScrollDirection = 0
  private readonly options: EditorOptions
  private readonly pluginHost: EditorPluginHost
  private readonly commandRouter: EditorCommandRouter
  private readonly document: EditorDocumentController
  private readonly editorFeatures = new Map<string, unknown>()
  private readonly editorFeatureContributions: EditorFeatureContribution[] = []
  private readonly viewContributionsByProvider = new Map<
    EditorViewContributionProvider,
    EditorViewContribution
  >()
  private readonly editorFeatureContributionsByProvider = new Map<
    EditorFeatureContributionProvider,
    EditorFeatureContribution
  >()
  private readonly keymap: EditorKeymapController
  private readonly viewContributions: EditorViewContributionController
  private readonly secondaryWork = new EditorSecondaryWorkScheduler()
  private readonly highlightPrefix: string
  private sessionChangeVersion = 0
  private blockSurfaces!: EditorBlockSurfaceController
  private readonly syntax: EditorSyntaxController
  private readonly inputSelection: InputSelectionController
  private configuredTheme: EditorTheme | null = null
  private rangeDecorations: readonly EditorRangeDecoration[] = []
  private appliedRangeDecorationNames: readonly string[] = []
  private appliedInjectedTextRows: readonly InjectedTextRow[] = []
  private directRowDecorations: ReadonlyMap<number, VirtualizedTextRowDecoration> = new Map()
  private readonly rowDecorationSources = new Map<
    string,
    ReadonlyMap<number, VirtualizedTextRowDecoration>
  >()
  private readonly tabSize: number

  private get text(): string {
    return this.document.text
  }

  private set text(text: string) {
    this.document.setRenderedText(text)
  }

  private get textSnapshot(): TextSnapshot {
    return this.document.textSnapshot
  }

  private get session(): DocumentSession | null {
    return this.document.session
  }

  private get sessionOptions(): EditorSessionOptions {
    return this.document.sessionOptions
  }

  private get documentId(): string | null {
    return this.document.documentId
  }

  private get documentMode(): EditorDocumentMode {
    return this.document.documentMode
  }

  private get editability(): EditorEditability {
    return this.document.editability
  }

  private get languageId(): EditorSyntaxLanguageId | null {
    return this.document.languageId
  }

  private get documentVersion(): number {
    return this.document.documentVersion
  }

  private get textVersion(): number {
    return this.document.textVersion
  }

  private get syntaxStatus(): EditorSyntaxStatus {
    return this.syntax.status
  }

  private get tokens(): readonly EditorToken[] {
    return this.syntax.tokens
  }

  constructor(container: HTMLElement, options: EditorOptions = {}) {
    const mountStart = nowMs()
    this.container = container
    this.options = options
    this.tabSize = normalizeTabSize(options.tabSize)
    this.configuredTheme = options.theme ?? null
    this.pluginHost = new EditorPluginHost(options.plugins)
    this.highlightPrefix = nextEditorHighlightPrefix()
    this.document = new EditorDocumentController({
      defaultDocumentMode: options.documentMode,
      defaultEditability: options.editability,
      highlightPrefix: this.highlightPrefix,
    })
    this.view = new VirtualizedTextView(container, {
      className: 'editor',
      highlightRegistry: getHighlightRegistry(),
      gutterContributions: this.pluginHost.getGutterContributions(),
      cursorLineHighlight: options.cursorLineHighlight,
      hiddenCharacters: options.hiddenCharacters,
      lineHeight: options.lineHeight,
      rowGap: options.rowGap,
      tabSize: this.tabSize,
      textMetrics: options.textMetrics,
      blockRowMount: (container, row) => this.blockSurfaces.mountRow(container, row),
      blockLaneMount: (container, lane) => this.blockSurfaces.mountLane(container, lane),
      onFoldToggle: this.handleFoldToggle,
      onViewportChange: this.handleViewportChange,
      selectionHighlightName: `${this.highlightPrefix}-selection`,
    })
    this.foldState = new EditorFoldState(this.view, () => this.session?.getSnapshot() ?? null)
    this.el = this.view.scrollElement
    this.blockSurfaces = new EditorBlockSurfaceController({
      view: this.view,
      getDocumentId: () => this.documentId,
      materializeFullText: () => this.text,
      focusEditor: () => this.focus(),
      setSelection: (anchor, head) =>
        this.inputSelection.applyFindSelection(anchor, head, 'editor.block.setSelection', head),
      notifyLayout: () => this.notifyViewContributions('layout', null),
    })
    this.syntax = new EditorSyntaxController({
      pluginHost: this.pluginHost,
      getDocumentVersion: () => this.documentVersion,
      getCurrentSessionDocumentId: () => this.currentSessionDocumentId(),
      getLanguageId: () => this.languageId,
      getSession: () => this.session,
      getVisibleSyntaxRange: () => this.visibleSyntaxRange(),
      adoptTokens: (tokens) => {
        this.view.adoptTokens(tokens)
        this.notifyViewContributions('tokens', null)
      },
      clearSyntaxFolds: () => this.clearSyntaxFolds(),
      setSyntaxFolds: (folds) => this.setSyntaxFolds(folds),
      notifyChange: (change) => this.notifyChange(change),
      notifyThemeChanged: () => this.applyResolvedTheme(),
    })
    this.inputSelection = new InputSelectionController({
      el: this.el,
      selectionSyncMode: normalizeEditorSelectionSyncMode(options.selectionSyncMode),
      tabSize: this.tabSize,
      view: this.view,
      getLanguageId: () => this.languageId,
      getSession: () => this.session,
      getSessionOptions: () => this.sessionOptions,
      materializeFullText: () => this.materializeFullText(),
      canEditDocument: () => this.canEditDocument(),
      applySessionChange: (change, totalName, totalStart, options) =>
        this.applySessionChange(change, totalName, totalStart, options),
      notifyChangeWithTiming: (change) => this.notifyChangeWithTiming(change),
      notifyViewContributions: (kind, change) => this.notifyViewContributions(kind, change),
    })
    this.commandRouter = new EditorCommandRouter({
      history: (command, context) => this.inputSelection.applyHistoryCommand(command, context),
      delete: (direction, context) => this.inputSelection.applyDeleteCommand(direction, context),
      indent: (direction, context) => this.inputSelection.applyIndentCommand(direction, context),
      editAction: (command, context) =>
        this.inputSelection.applyEditActionCommand(command, context),
      selectAll: (context) => this.inputSelection.applySelectAllCommand(context),
      addNextOccurrence: (context) => this.inputSelection.applyAddNextOccurrenceCommand(context),
      clearSecondarySelections: (context) =>
        this.inputSelection.applyClearSecondarySelections(context),
      insertCursor: (direction, context) =>
        this.inputSelection.applyInsertCursorCommand(direction, context),
      selectExactOccurrences: (command, context) =>
        this.inputSelection.applySelectExactOccurrencesCommand(command, context),
      moveSelectionToNextOccurrence: (context) =>
        this.inputSelection.applyMoveSelectionToNextOccurrenceCommand(context),
      navigation: (command, context) =>
        this.inputSelection.applyNavigationCommand(command, context),
    })
    this.applyResolvedTheme()
    if (this.pluginHost.hasHighlighterProviders()) this.syntax.refreshHighlighterTheme()
    this.createInitialEditorFeatureContributions(
      this.pluginHost.getEditorFeatureContributionProviders(),
    )
    this.keymap = new EditorKeymapController({
      target: this.el,
      keymap: options.keymap,
      dispatch: (command, context) => this.dispatchCommand(command, context),
    })
    this.viewContributions = new EditorViewContributionController(
      this.createInitialViewContributions(this.pluginHost.getViewContributionProviders()),
      () => this.createViewSnapshot(),
    )
    this.pluginHost.setEvents({
      onHighlighterProvidersChanged: () => this.syntax.reloadHighlighterAndSyntax(),
      onSyntaxProvidersChanged: () => this.syntax.reloadSyntaxSession(),
      onViewContributionProviderAdded: (provider) => this.addViewContributionProvider(provider),
      onViewContributionProviderRemoved: (provider) =>
        this.removeViewContributionProvider(provider),
      onEditorFeatureContributionProviderAdded: (provider) =>
        this.addEditorFeatureContributionProvider(provider),
      onEditorFeatureContributionProviderRemoved: (provider) =>
        this.removeEditorFeatureContributionProvider(provider),
      onGutterContributionsChanged: () => this.syncGutterContributions(),
      onBlockProvidersChanged: () => this.handleBlockProvidersChanged(),
      onInjectedTextRowProvidersChanged: () => this.handleInjectedTextRowProvidersChanged(),
    })
    this.inputSelection.install()
    this.initializeDefaultText()
    this.setRangeDecorations(options.rangeDecorations ?? [])
    recordEditorMountTiming(nowMs() - mountStart)
  }

  setContent(text: string): void {
    this.text = text
    this.view.setText(text)
    this.syncEditorBlocks()
    this.syncInjectedTextRows()
    this.setTokens([])
    this.clearSyntaxFolds()
    this.applyRangeDecorations()
    this.notifyViewContributions('content', null)
  }

  setTokens(tokens: readonly EditorToken[]): void {
    copyTokenProjectionMetadata(tokens, tokens)
    this.adoptTokens(tokens)
  }

  applyEdit(edit: TextEdit, tokens: readonly EditorToken[], textSnapshot?: TextSnapshot): void {
    const nextTextSnapshot = textSnapshot ?? this.legacyEditTextSnapshot(edit)
    this.document.setRenderedTextSnapshot(nextTextSnapshot)
    measureEditorPerformance('editor.view.applyEdit', () =>
      this.view.applyEdit(edit, nextTextSnapshot),
    )
    this.syncEditorBlocks()
    this.syncInjectedTextRows()
    measureEditorPerformance(
      'editor.tokens.adoptProjected',
      () => this.adoptTokens(tokens),
      () => ({
        tokenCount: tokens.length,
      }),
    )
  }

  private adoptTokens(tokens: readonly EditorToken[]): void {
    this.syntax.setTokens(tokens)
  }

  setDocument(document: EditorDocument): void {
    this.setContent(document.text)
    this.setTokens(document.tokens ?? [])
  }

  setFoldMap(foldMap: FoldMap | null): void {
    this.view.setFoldMap(foldMap)
  }

  setSyntaxFolds(folds: readonly FoldRange[]): void {
    this.foldState.setSyntaxFolds(folds)
  }

  toggleFold(offset?: number): boolean {
    return this.applyFoldOperation('toggle', offset)
  }

  fold(offset?: number): boolean {
    return this.applyFoldOperation('fold', offset)
  }

  unfold(offset?: number): boolean {
    return this.applyFoldOperation('unfold', offset)
  }

  foldAll(): boolean {
    if (!this.session) return false

    const changed = this.foldState.foldAll()
    if (changed) this.notifyViewContributions('layout', null)
    return changed
  }

  unfoldAll(): boolean {
    if (!this.session) return false

    const changed = this.foldState.unfoldAll()
    if (changed) this.notifyViewContributions('layout', null)
    return changed
  }

  setText(text: string, options: EditorSetTextOptions = {}): void {
    const currentScrollPosition = this.getScrollPosition()
    const documentVersion = this.resetOwnedDocument(
      {
        text,
        documentMode: options.documentMode ?? this.documentMode,
        languageId: options.languageId,
      },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: preservedScrollPosition(currentScrollPosition, options.scrollPosition),
      },
    )
    this.notifyChange(null)
    this.refreshSyntax(documentVersion, null)
  }

  syncText(text: string, options: EditorSetTextOptions = {}): void {
    const documentMode = normalizeEditorDocumentMode(options.documentMode ?? this.documentMode)
    const languageId = options.languageId ?? null
    if (!this.session || documentMode !== this.documentMode || languageId !== this.languageId) {
      this.setText(text, options)
      return
    }
    if (this.materializeFullText() === text) return

    const scrollPosition = preservedScrollPosition(this.getScrollPosition(), options.scrollPosition)
    const change = this.session.applyEdits([syncTextEdit(this.text, text)], {
      history: 'skip',
    })
    if (change.kind === 'none') return

    this.applySessionChange(change, 'editor.syncText', nowMs(), {
      syncDomSelection: false,
    })
    this.applyDocumentScrollPosition(scrollPosition)
  }

  edit(editOrEdits: EditorEditInput, options: EditorEditOptions = {}): void {
    if (!this.canEditDocument()) return

    this.ensureAnonymousSession()
    if (!this.session) return

    const edits = normalizeEditorEditInput(editOrEdits)
    const change = this.session.applyEdits(edits, options)
    if (change.kind === 'none') return

    this.applySessionChange(change, 'editor.edit', nowMs())
  }

  openDocument(document: EditorOpenDocumentOptions): void {
    const documentVersion = this.resetOwnedDocument(document, {
      documentId: document.documentId ?? null,
      persistentIdentity: true,
      scrollPosition: document.scrollPosition,
    })
    this.notifyChange(null)
    this.refreshSyntax(documentVersion, null)
  }

  private ensureAnonymousSession(): void {
    if (this.session) return

    this.resetOwnedDocument(
      { text: '', languageId: null },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: DOCUMENT_START_SCROLL_POSITION,
      },
    )
  }

  clearDocument(): void {
    this.clear()
    this.notifyChange(null)
  }

  getState(): EditorState {
    const snapshot = this.session?.getSnapshot()
    const length = snapshot?.length ?? this.text.length
    const selection = this.session?.getSelections().selections[0]
    const resolved = snapshot && selection ? resolveSelection(snapshot, selection) : null
    const point = snapshot ? offsetToPoint(snapshot, resolved?.headOffset ?? length) : null

    return {
      documentId: this.documentId,
      documentMode: this.documentMode,
      editability: this.editability,
      languageId: this.languageId,
      syntaxStatus: this.syntaxStatus,
      cursor: {
        row: point?.row ?? 0,
        column: point?.column ?? 0,
      },
      length,
      canUndo: this.session?.canUndo() ?? false,
      canRedo: this.session?.canRedo() ?? false,
      isDirty: this.session?.isDirty() ?? false,
    }
  }

  materializeFullText(): string {
    return this.session?.materializeFullText() ?? this.text
  }

  getTextSnapshot(): TextSnapshot {
    return this.textSnapshot
  }

  getMergeConflicts(): readonly MergeConflictRegion[] {
    return parseMergeConflicts(this.materializeFullText())
  }

  resolveMergeConflict(index: number, resolution: MergeConflictResolution): boolean {
    if (!this.canEditDocument()) return false

    const text = this.materializeFullText()
    const conflict = parseMergeConflicts(text)[index]
    if (!conflict) return false

    const resolved = resolveMergeConflictText(text, conflict, resolution)
    if (!resolved) return false

    this.edit(
      { from: resolved.range.start, to: resolved.range.end, text: resolved.replacement },
      {
        selection: {
          anchor: resolved.selection.start,
          head: resolved.selection.end,
        },
      },
    )
    return true
  }

  revealMergeConflict(index: number): boolean {
    const conflict = parseMergeConflicts(this.materializeFullText())[index]
    if (!conflict) return false

    this.setSelection(conflict.range.start)
    return true
  }

  focus(): void {
    this.view.focusInput()
  }

  setSelection(anchor: number, head = anchor, reveal?: EditorSelectionRevealTarget): void {
    const revealOffset = selectionRevealOffset(reveal, head)
    this.inputSelection.applyFindSelection(anchor, head, 'editor.setSelection', revealOffset)
  }

  openFind(): boolean {
    return this.findFeature()?.openFind() ?? false
  }

  openFindReplace(): boolean {
    return this.findFeature()?.openFindReplace() ?? false
  }

  closeFind(): boolean {
    return this.findFeature()?.closeFind() ?? false
  }

  findNext(): boolean {
    return this.findFeature()?.findNext() ?? false
  }

  findPrevious(): boolean {
    return this.findFeature()?.findPrevious() ?? false
  }

  replaceOne(): boolean {
    return this.findFeature()?.replaceOne() ?? false
  }

  replaceAll(): boolean {
    return this.findFeature()?.replaceAll() ?? false
  }

  selectAllMatches(): boolean {
    return this.findFeature()?.selectAllMatches() ?? false
  }

  getScrollPosition(): Required<EditorScrollPosition> {
    const viewState = this.view.getState()
    return {
      top: viewState.scrollTop,
      left: viewState.scrollLeft,
    }
  }

  setScrollPosition(scrollPosition: EditorScrollPosition): void {
    this.applyScrollPosition(scrollPosition)
  }

  setTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null
    if (editorThemesEqual(this.configuredTheme, nextTheme)) return

    this.configuredTheme = nextTheme
    this.applyResolvedTheme()
    this.notifyViewContributions('tokens', null)
  }

  setHiddenCharacters(mode: HiddenCharactersMode): void {
    this.view.setHiddenCharacters(mode)
  }

  setKeymap(keymap: EditorOptions['keymap']): void {
    this.keymap.setKeymap(keymap)
  }

  setEditability(editability: EditorEditability): void {
    if (!this.document.setEditability(editability)) return

    this.syncViewEditability()
    this.notifyChange(null)
  }

  setRangeDecorations(decorations: readonly EditorRangeDecoration[]): void {
    if (sameEditorRangeDecorations(this.rangeDecorations, decorations)) return

    this.rangeDecorations = decorations
    this.applyRangeDecorations()
  }

  setRowDecorations(decorations: ReadonlyMap<number, VirtualizedTextRowDecoration>): void {
    this.directRowDecorations = new Map(decorations)
    this.applyComposedRowDecorations()
  }

  setLineHeight(lineHeight: number): void {
    if (!this.view.setLineHeight(lineHeight)) return

    this.notifyViewContributions('layout', null)
  }

  setRowGap(rowGap: number): void {
    if (!this.view.setRowGap(rowGap)) return

    this.notifyViewContributions('layout', null)
  }

  addPlugin(plugin: EditorPlugin): EditorDisposable {
    return this.pluginHost.addPlugin(plugin)
  }

  removePlugin(plugin: EditorPlugin): boolean {
    return this.pluginHost.removePlugin(plugin)
  }

  setPlugins(plugins: readonly EditorPlugin[]): void {
    this.pluginHost.setPlugins(plugins)
  }

  dispatchCommand(command: EditorCommandId, context: EditorCommandContext = {}): boolean {
    return this.commandRouter.dispatch(command, context)
  }

  attachSession(session: DocumentSession, options: EditorSessionOptions = {}): void {
    const attachment = this.document.attachSession(session, options)
    this.syntax.startDocument({
      documentId: attachment.internalDocumentId,
      languageId: attachment.languageId,
      textSnapshot: attachment.textSnapshot,
      snapshot: attachment.session.getSnapshot(),
    })
    this.syncViewEditability()
    this.setDocument({ text: attachment.fullText, tokens: [] })
    this.applyDocumentScrollPosition(options.scrollPosition)
    this.inputSelection.syncDomSelection()
    this.notifyViewContributions('document', null)
    this.notifyChange(null)
    this.refreshSyntax(attachment.documentVersion, null)
  }

  detachSession(): void {
    this.document.detachSession()
    this.inputSelection.clearSelectionHighlight()
    this.view.setEditable(false)
  }

  clear(): void {
    this.document.clear()
    this.syntax.clearDocument()
    this.inputSelection.clearSelectionHighlight()
    this.view.setEditable(false)
    this.setContent('')
    this.applyDocumentScrollPosition()
    this.notifyViewContributions('clear', null)
  }

  dispose(): void {
    this.secondaryWork.dispose()
    this.blockSurfaces.dispose()
    this.inputSelection.dispose()
    this.viewContributions.dispose()
    this.disposeEditorFeatureContributions()
    this.keymap.dispose()
    this.syntax.dispose()
    this.detachSession()
    this.pluginHost.dispose()
    this.view.dispose()
  }

  private resetOwnedDocument(
    document: EditorOpenDocumentOptions,
    options: ResetOwnedDocumentOptions,
  ): number {
    const attachment = this.document.resetOwnedDocument(document, options)
    this.syntax.startDocument({
      documentId: attachment.internalDocumentId,
      languageId: attachment.languageId,
      textSnapshot: attachment.textSnapshot,
      snapshot: attachment.session.getSnapshot(),
    })
    this.syncViewEditability()
    this.setDocument({ text: attachment.fullText, tokens: [] })
    this.applyRangeDecorations()
    this.applyDocumentScrollPosition(options.scrollPosition)
    this.inputSelection.syncDomSelection()
    this.notifyViewContributions('document', null)
    return attachment.documentVersion
  }

  private initializeDefaultText(): void {
    if (this.options.defaultText === undefined) return

    this.resetOwnedDocument(
      {
        text: this.options.defaultText,
        documentMode: normalizeEditorDocumentMode(this.options.documentMode),
        languageId: null,
      },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: DOCUMENT_START_SCROLL_POSITION,
      },
    )
  }

  private applyDocumentScrollPosition(scrollPosition?: EditorScrollPosition): void {
    this.applyScrollPosition({
      top: scrollPosition?.top ?? DOCUMENT_START_SCROLL_POSITION.top,
      left: scrollPosition?.left ?? DOCUMENT_START_SCROLL_POSITION.left,
    })
  }

  private applyScrollPosition(scrollPosition: EditorScrollPosition): void {
    const viewState = this.view.getState()
    const scrollTop = normalizeScrollOffset(
      scrollPosition.top,
      viewState.scrollTop,
      viewState.scrollHeight - viewState.viewportHeight,
    )
    const scrollLeft = normalizeScrollOffset(
      scrollPosition.left,
      viewState.scrollLeft,
      viewState.scrollWidth - viewState.viewportWidth,
    )
    if (scrollTop === viewState.scrollTop && scrollLeft === viewState.scrollLeft) return

    this.el.scrollTop = scrollTop
    this.el.scrollLeft = scrollLeft
    this.view.setScrollMetrics(
      scrollTop,
      viewState.viewportHeight,
      viewState.viewportWidth,
      scrollLeft,
    )
  }

  private currentSessionDocumentId(): string {
    return this.document.currentSessionDocumentId()
  }

  private createInitialViewContributions(
    providers: readonly EditorViewContributionProvider[],
  ): EditorViewContribution[] {
    const contributions: EditorViewContribution[] = []
    for (const provider of providers) {
      const contribution = this.createViewContribution(provider)
      if (!contribution) continue

      contributions.push(contribution)
      this.viewContributionsByProvider.set(provider, contribution)
    }

    return contributions
  }

  private addViewContributionProvider(provider: EditorViewContributionProvider): void {
    const contribution = this.createViewContribution(provider)
    if (!contribution) return

    this.viewContributionsByProvider.set(provider, contribution)
    this.viewContributions.add(contribution)
  }

  private removeViewContributionProvider(provider: EditorViewContributionProvider): void {
    const contribution = this.viewContributionsByProvider.get(provider)
    if (!contribution) return

    this.viewContributionsByProvider.delete(provider)
    this.viewContributions.remove(contribution)
  }

  private createViewContribution(
    provider: EditorViewContributionProvider,
  ): EditorViewContribution | null {
    return provider.createContribution(this.createViewContributionContext(this.container))
  }

  private createInitialEditorFeatureContributions(
    providers: readonly EditorFeatureContributionProvider[],
  ): void {
    for (const provider of providers) this.addEditorFeatureContributionProvider(provider, false)
  }

  private addEditorFeatureContributionProvider(
    provider: EditorFeatureContributionProvider,
    notify = true,
  ): void {
    const contribution = provider.createContribution(
      this.createEditorFeatureContributionContext(this.container),
    )
    if (!contribution) return

    this.editorFeatureContributionsByProvider.set(provider, contribution)
    this.editorFeatureContributions.push(contribution)
    if (notify) contribution.handleEditorChange?.(null)
  }

  private removeEditorFeatureContributionProvider(
    provider: EditorFeatureContributionProvider,
  ): void {
    const contribution = this.editorFeatureContributionsByProvider.get(provider)
    if (!contribution) return

    this.editorFeatureContributionsByProvider.delete(provider)
    removeArrayItem(this.editorFeatureContributions, contribution)
    contribution.dispose()
  }

  private disposeEditorFeatureContributions(): void {
    while (this.editorFeatureContributions.length > 0) {
      this.editorFeatureContributions.pop()?.dispose()
    }
    this.editorFeatureContributionsByProvider.clear()
  }

  private syncGutterContributions(): void {
    if (!this.view.setGutterContributions(this.pluginHost.getGutterContributions())) return

    this.notifyViewContributions('layout', null)
  }

  private handleBlockProvidersChanged(): void {
    this.syncEditorBlocks()
    this.notifyViewContributions('layout', null)
  }

  private syncEditorBlocks(): void {
    this.blockSurfaces.sync(this.pluginHost.getBlockProviders())
  }

  private handleInjectedTextRowProvidersChanged(): void {
    if (!this.syncInjectedTextRows()) return

    this.notifyViewContributions('layout', null)
    this.inputSelection.syncDomSelection()
  }

  private syncInjectedTextRows(): boolean {
    const rows = this.injectedTextRowsForProviders()
    if (sameInjectedTextRows(this.appliedInjectedTextRows, rows)) return false

    this.appliedInjectedTextRows = rows
    this.view.setInjectedTextRows(rows)
    return true
  }

  private injectedTextRowsForProviders(): readonly InjectedTextRow[] {
    const providers = this.pluginHost.getInjectedTextRowProviders()
    if (providers.length === 0) return []

    const context = this.createInjectedTextRowProviderContext()
    const rows: InjectedTextRow[] = []
    for (const provider of providers) rows.push(...provider.getInjectedTextRows(context))
    return rows
  }

  private createInjectedTextRowProviderContext(): EditorInjectedTextRowProviderContext {
    return {
      documentId: this.documentId,
      text: this.materializeFullText(),
      lineCount: this.view.getLineCount(),
    }
  }

  private setSourceRowDecorations(
    sourceId: string,
    decorations: ReadonlyMap<number, VirtualizedTextRowDecoration>,
  ): void {
    if (sourceId.length === 0) return

    this.rowDecorationSources.set(sourceId, new Map(decorations))
    this.applyComposedRowDecorations()
  }

  private clearSourceRowDecorations(sourceId: string): void {
    if (!this.rowDecorationSources.delete(sourceId)) return

    this.applyComposedRowDecorations()
  }

  private applyComposedRowDecorations(): void {
    this.view.setRowDecorations(this.composedRowDecorations())
    this.view.refreshGutterWidth()
    this.notifyViewContributions('layout', null)
  }

  private composedRowDecorations(): ReadonlyMap<number, VirtualizedTextRowDecoration> {
    const composed = new Map<number, VirtualizedTextRowDecoration>()
    mergeRowDecorationMap(composed, this.directRowDecorations)
    for (const decorations of this.rowDecorationSources.values()) {
      mergeRowDecorationMap(composed, decorations)
    }

    return composed
  }

  private projectRowDecorationsThroughLineEdit(
    edit: TextEdit,
    previousText: TextSnapshot,
    lineStarts: readonly number[],
  ): boolean {
    const rowDelta = editLineDelta(edit, previousText)
    if (rowDelta === 0) return false
    if (this.directRowDecorations.size === 0 && this.rowDecorationSources.size === 0) return false

    const startRow = rowForOffset(lineStarts, edit.from)
    const endRow = rowForOffset(lineStarts, edit.to)
    this.directRowDecorations = projectRowDecorationMapThroughLineEdit(
      this.directRowDecorations,
      startRow,
      endRow,
      rowDelta,
    )
    for (const [sourceId, decorations] of this.rowDecorationSources) {
      this.rowDecorationSources.set(
        sourceId,
        projectRowDecorationMapThroughLineEdit(decorations, startRow, endRow, rowDelta),
      )
    }

    return true
  }

  private createViewContributionContext(container: HTMLElement): EditorViewContributionContext {
    return {
      container,
      scrollElement: this.el,
      highlightPrefix: this.highlightPrefix,
      getSnapshot: () => this.createViewSnapshot(),
      getFeature: (id) => this.getFeature(id),
      revealLine: (row) => this.view.scrollToRow(row),
      focusEditor: () => this.focus(),
      setSelection: (anchor, head, timingName, revealOffset) =>
        this.inputSelection.applyFindSelection(anchor, head, timingName, revealOffset),
      reserveOverlayWidth: (side, width) => this.reserveOverlayWidth(side, width),
      setScrollTop: (scrollTop) => this.setScrollTop(scrollTop),
      textOffsetFromPoint: (clientX, clientY) =>
        this.inputSelection.textOffsetFromPoint(clientX, clientY),
      getRangeClientRect: (start, end) => this.inputSelection.rangeClientRect(start, end),
      setRangeHighlight: (name, ranges, style) => this.view.setRangeHighlight(name, ranges, style),
      clearRangeHighlight: (name) => this.view.clearRangeHighlight(name),
    }
  }

  private createEditorFeatureContributionContext(
    container: HTMLElement,
  ): EditorFeatureContributionContext {
    return {
      container,
      scrollElement: this.el,
      highlightPrefix: this.highlightPrefix,
      hasDocument: () => this.session !== null,
      materializeFullText: () => this.materializeFullText(),
      getTextSnapshot: () => this.session?.getTextSnapshot() ?? null,
      getSelections: () => this.inputSelection.resolveViewSelections(),
      focusEditor: () => this.focus(),
      setSelection: (anchor, head, timingName, revealOffset) =>
        this.inputSelection.applyFindSelection(anchor, head, timingName, revealOffset),
      setSelections: (selections, timingName, revealOffset) =>
        this.inputSelection.applyFindSelections(selections, timingName, revealOffset),
      applyEdits: (edits, timingName, selection) =>
        this.inputSelection.applyFindEdits(edits, timingName, selection),
      setRangeHighlight: (name, ranges, style) => this.view.setRangeHighlight(name, ranges, style),
      clearRangeHighlight: (name) => this.view.clearRangeHighlight(name),
      setRowDecorations: (sourceId, decorations) =>
        this.setSourceRowDecorations(sourceId, decorations),
      clearRowDecorations: (sourceId) => this.clearSourceRowDecorations(sourceId),
      registerCommand: (command, handler) => this.registerCommandHandler(command, handler),
      registerFeature: (id, feature) => this.registerFeature(id, feature),
    }
  }

  private canEditDocument(): boolean {
    return this.document.canEditDocument()
  }

  private syncViewEditability(): void {
    const editable = this.canEditDocument()
    this.view.setEditable(editable)
    this.inputSelection.syncNativeInputHandlers(editable)
  }

  private applyRangeDecorations(): void {
    if (this.textSnapshot.length === 0 || this.rangeDecorations.length === 0) {
      this.clearAppliedRangeDecorations()
      return
    }

    const groups = groupedRangeDecorations(this.rangeDecorations, this.highlightPrefix)
    const names: string[] = []

    for (const group of groups) {
      names.push(group.name)
      this.view.setRangeHighlight(group.name, group.ranges, group.style)
    }

    this.clearStaleAppliedRangeDecorations(new Set(names))
    this.appliedRangeDecorationNames = names
  }

  private clearAppliedRangeDecorations(): void {
    for (const name of this.appliedRangeDecorationNames) this.view.clearRangeHighlight(name)
    this.appliedRangeDecorationNames = []
  }

  private clearStaleAppliedRangeDecorations(nextNames: ReadonlySet<string>): void {
    for (const name of this.appliedRangeDecorationNames) {
      if (!nextNames.has(name)) this.view.clearRangeHighlight(name)
    }
  }

  private createViewSnapshot(): EditorViewSnapshot {
    const viewState = this.view.getState()
    const textSnapshot = this.textSnapshot
    const viewport = {
      scrollTop: viewState.scrollTop,
      scrollLeft: viewState.scrollLeft,
      scrollHeight: viewState.scrollHeight,
      scrollWidth: viewState.scrollWidth,
      clientHeight: viewState.viewportHeight,
      clientWidth: viewState.viewportWidth,
      borderBoxHeight: viewState.borderBoxHeight,
      borderBoxWidth: viewState.borderBoxWidth,
      visibleRange: viewState.visibleRange,
    }

    return defineLazyFullTextProperty({
      documentId: this.documentId,
      languageId: this.languageId,
      theme: this.resolvedTheme(),
      textSnapshot,
      textVersion: this.textVersion,
      lineStarts: this.view.getLineStarts(),
      tokens: this.tokens,
      selections: this.inputSelection.resolveViewSelections(),
      metrics: viewState.metrics,
      lineCount: viewState.lineCount,
      contentWidth: viewState.contentWidth,
      totalHeight: viewState.totalHeight,
      tabSize: viewState.tabSize,
      foldMarkers: viewState.foldMarkers,
      visibleRows: viewState.mountedRows.map((row) => ({
        index: row.index,
        bufferRow: row.bufferRow,
        source: row.source,
        injectedTextRowId: row.injectedTextRowId,
        metadata: row.metadata,
        startOffset: row.startOffset,
        endOffset: row.endOffset,
        text: row.text,
        kind: row.kind,
        primaryText: row.source === 'document' && row.displayKind === 'text',
        top: row.top,
        height: row.height,
      })),
      viewport,
    })
  }

  private notifyViewContributions(
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    if (!this.viewContributions) return

    this.viewContributions.notify(kind, change ?? null)
  }

  private notifyEditorFeatureContributions(change: DocumentSessionChange | null): void {
    for (const contribution of this.editorFeatureContributions) {
      contribution.handleEditorChange?.(change)
    }
  }

  private registerCommandHandler(
    command: EditorCommandId,
    handler: EditorCommandHandler,
  ): EditorDisposable {
    return this.commandRouter.registerCommandHandler(command, handler)
  }

  private registerFeature<T>(id: string, feature: T): EditorDisposable {
    this.editorFeatures.set(id, feature)

    return {
      dispose: () => this.unregisterFeature(id, feature),
    }
  }

  private unregisterFeature<T>(id: string, feature: T): void {
    if (this.editorFeatures.get(id) !== feature) return

    this.editorFeatures.delete(id)
  }

  private getFeature<T>(id: string): T | null {
    return (this.editorFeatures.get(id) as T | undefined) ?? null
  }

  private findFeature(): EditorFindFeature | null {
    return (
      (this.editorFeatures.get(EDITOR_FIND_FEATURE_ID) as EditorFindFeature | undefined) ?? null
    )
  }

  private reserveOverlayWidth(side: EditorOverlaySide, width: number): void {
    if (!this.view.reserveOverlayWidth(side, width)) return

    this.notifyViewContributions('layout', null)
  }

  private setScrollTop(scrollTop: number): void {
    this.applyScrollPosition({
      top: scrollTop,
      left: this.view.getState().scrollLeft,
    })
  }

  private readonly handleViewportChange = (): void => {
    this.updateSyntaxScrollTracking()
    const visibleRange = this.visibleSyntaxRange()
    this.syntax.refreshVisibleRange(this.documentVersion, {
      delayMs: 0,
      range: visibleRange,
    })
    this.syntax.prefetchVisibleRange(this.documentVersion, this.visibleSyntaxPrefetchRange(), {
      delayMs: VISIBLE_SYNTAX_SCROLL_DELAY_MS,
    })
    this.syntax.warmSyntaxAroundRange(this.documentVersion, visibleRange, {
      delayMs: BACKGROUND_SYNTAX_WARM_DELAY_MS,
    })
    this.notifyViewContributions('viewport', null)
  }

  private visibleSyntaxRange(): EditorSyntaxRange | null {
    return this.syntaxRangeAroundMountedRows(
      VISIBLE_SYNTAX_OVERSCAN_CHARS,
      VISIBLE_SYNTAX_OVERSCAN_CHARS,
    )
  }

  private visibleSyntaxPrefetchRange(): EditorSyntaxRange | null {
    const viewState = this.view.getState()
    const rows = viewState.mountedRows
    const first = rows[0]
    const last = rows.at(-1)
    if (!first || !last) return null

    const lead = this.visibleSyntaxLeadChars(first, last)
    const before = this.syntaxScrollDirection <= 0 ? lead : VISIBLE_SYNTAX_TRAILING_CHARS
    const after = this.syntaxScrollDirection >= 0 ? lead : VISIBLE_SYNTAX_TRAILING_CHARS

    return this.syntaxRangeAroundMountedRows(before, after)
  }

  private syntaxRangeAroundMountedRows(before: number, after: number): EditorSyntaxRange | null {
    const rows = this.view.getState().mountedRows
    const first = rows[0]
    const last = rows.at(-1)
    if (!first || !last) return null

    return {
      startIndex: Math.max(0, first.startOffset - before),
      endIndex: Math.min(this.textSnapshot.length, last.endOffset + after),
    }
  }

  private updateSyntaxScrollTracking(): void {
    const scrollTop = this.view.getState().scrollTop
    const previousScrollTop = this.lastSyntaxScrollTop
    this.lastSyntaxScrollTop = scrollTop
    if (previousScrollTop === null) {
      this.syntaxScrollDeltaPx = 0
      this.syntaxScrollDirection = 0
      return
    }

    const delta = scrollTop - previousScrollTop
    this.syntaxScrollDeltaPx = Math.abs(delta)
    this.syntaxScrollDirection = syntaxScrollDirection(delta)
  }

  private visibleSyntaxLeadChars(
    first: { readonly startOffset: number; readonly top: number },
    last: { readonly endOffset: number; readonly top: number; readonly height: number },
  ): number {
    const textSpan = Math.max(1, last.endOffset - first.startOffset)
    const pixelSpan = Math.max(1, last.top + last.height - first.top)
    const velocityLead = Math.ceil(this.syntaxScrollDeltaPx * (textSpan / pixelSpan) * 2)
    return clamp(
      Math.max(VISIBLE_SYNTAX_LEAD_CHARS, velocityLead),
      VISIBLE_SYNTAX_LEAD_CHARS,
      Math.min(VISIBLE_SYNTAX_MAX_LEAD_CHARS, this.textSnapshot.length),
    )
  }

  private applySessionChange(
    change: DocumentSessionChange,
    totalName = 'editor.change',
    totalStart = nowMs(),
    options: SessionChangeOptions = {},
  ): void {
    this.syntax.projectCacheForChange(change)
    let timedChange = change
    const renderStart = nowMs()
    measureEditorPerformance('editor.renderSessionChange', () => this.renderSessionChange(change))
    timedChange = appendTiming(timedChange, 'editor.render', renderStart)

    if (options.revealOffset !== undefined) {
      const revealStart = nowMs()
      this.view.revealOffset(options.revealOffset, options.revealBlock)
      timedChange = appendTiming(timedChange, 'editor.reveal', revealStart)
    }

    if (options.syncDomSelection !== false) {
      const selectionStart = nowMs()
      this.inputSelection.syncDomSelection()
      timedChange = appendTiming(timedChange, 'editor.syncDomSelection', selectionStart)
    }
    const finalChange = appendTiming(timedChange, totalName, totalStart)
    this.sessionOptions.onChange?.(finalChange)
    measureEditorPerformance('editor.notifyViewContributions', () =>
      this.notifyViewContributions(viewContributionKindForChange(finalChange), finalChange),
    )
    measureEditorPerformance('editor.notifyChangeWithTiming', () =>
      this.notifyChangeWithTiming(finalChange),
    )
    this.sessionChangeVersion += 1
    this.scheduleSecondarySessionChangeWork(finalChange, totalName, this.sessionChangeVersion)
  }

  private renderSessionChange(change: DocumentSessionChange): void {
    const edit = change.edits[0]
    if (change.kind === 'selection' || change.kind === 'none') return

    if (edit && change.edits.length === 1) {
      const previousTextSnapshot = this.textSnapshot
      const foldProjection = measureEditorPerformance(
        'editor.projectSyntaxFolds',
        () => projectSyntaxFoldsThroughLineEdit(this.foldState.folds, edit, previousTextSnapshot),
        () => ({ foldCount: this.foldState.folds.length }),
      )
      const projectedTokens = measureEditorPerformance(
        'editor.projectTokens',
        () => projectTokensThroughEdit(this.tokens, edit, previousTextSnapshot),
        () => ({ tokenCount: this.tokens.length }),
      )
      const rowDecorationsProjected = this.projectRowDecorationsThroughLineEdit(
        edit,
        previousTextSnapshot,
        this.view.getLineStarts(),
      )
      this.applyEdit(edit, projectedTokens, documentSessionChangeTextSnapshot(change))
      this.foldState.applyProjection(foldProjection)
      if (rowDecorationsProjected) this.view.setRowDecorations(this.composedRowDecorations())
      return
    }

    this.clearSyntaxFolds()
    this.setDocument({ text: change.textSnapshot.materializeFullText(), tokens: [] })
  }

  private legacyEditTextSnapshot(edit: TextEdit): TextSnapshot {
    const currentText = this.text
    return createStringTextSnapshot(
      `${currentText.slice(0, edit.from)}${edit.text}${currentText.slice(edit.to)}`,
    )
  }

  private notifyChange(change: DocumentSessionChange | null): void {
    this.notifyEditorFeatureContributions(change)
    this.options.onChange?.(this.getState(), change)
  }

  private notifyChangeWithTiming(change: DocumentSessionChange): void {
    const notifyStart = nowMs()
    const state = this.getState()
    const timedChange = appendTiming(change, 'editor.notify', notifyStart)
    this.options.onChange?.(state, timedChange)
  }

  private refreshSyntax(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: { readonly delayMs?: number } = {},
  ): void {
    this.syntax.refresh(documentVersion, change, options)
  }

  private scheduleSecondarySessionChangeWork(
    change: DocumentSessionChange,
    timingName: string,
    sessionChangeVersion: number,
  ): void {
    const documentVersion = this.documentVersion
    if (!this.shouldDeferSecondarySessionWork(change, timingName)) {
      this.runSecondarySessionChangeWork(documentVersion, change)
      return
    }

    this.secondaryWork.schedule({
      key: 'editor.syntaxRefresh',
      delayMs: RAPID_INPUT_SECONDARY_WORK_DELAY_MS,
      version: sessionChangeVersion,
      isCurrent: (version) => version === this.sessionChangeVersion,
      run: () =>
        measureEditorPerformance('editor.refreshSyntax', () =>
          this.refreshSyntax(documentVersion, change, { delayMs: 0 }),
        ),
    })
    this.secondaryWork.schedule({
      key: 'editor.featureContributions',
      delayMs: RAPID_INPUT_SECONDARY_WORK_DELAY_MS,
      version: sessionChangeVersion,
      isCurrent: (version) => version === this.sessionChangeVersion,
      run: () =>
        measureEditorPerformance('editor.notifyEditorFeatureContributions', () =>
          this.notifyEditorFeatureContributions(change),
        ),
    })
  }

  private runSecondarySessionChangeWork(
    documentVersion: number,
    change: DocumentSessionChange,
  ): void {
    measureEditorPerformance('editor.refreshSyntax', () =>
      this.refreshSyntax(documentVersion, change),
    )
    measureEditorPerformance('editor.notifyEditorFeatureContributions', () =>
      this.notifyEditorFeatureContributions(change),
    )
  }

  private shouldDeferSecondarySessionWork(
    change: DocumentSessionChange,
    timingName: string,
  ): boolean {
    if (change.kind === 'selection' || change.kind === 'none') return false
    return RAPID_INPUT_TIMING_NAMES.has(timingName)
  }

  private handleFoldToggle = (marker: VirtualizedFoldMarker): void => {
    if (!this.foldState.toggle(marker)) return

    this.notifyViewContributions('layout', null)
  }

  private applyFoldOperation(operation: FoldOperation, offset?: number): boolean {
    const location = this.foldLocation(offset)
    if (!location) return false

    const fold = foldCandidateAtLocation(
      this.foldState.folds,
      location.row,
      location.offset,
      (candidate) => this.foldState.isCollapsed(candidate),
      operation,
    )
    if (!fold) return false

    const changed = this.applyFoldStateChange(operation, fold)
    if (changed) this.notifyViewContributions('layout', null)
    return changed
  }

  private foldLocation(offset?: number): { readonly offset: number; readonly row: number } | null {
    const snapshot = this.session?.getSnapshot()
    if (!snapshot) return null

    const locationOffset = clamp(
      offset ?? this.primarySelectionHeadOffsetFromSession(),
      0,
      snapshot.length,
    )
    return {
      offset: locationOffset,
      row: offsetToPoint(snapshot, locationOffset).row,
    }
  }

  private primarySelectionHeadOffsetFromSession(): number {
    const snapshot = this.session?.getSnapshot()
    const selection = this.session?.getSelections().selections[0]
    if (!snapshot || !selection) return this.materializeFullText().length

    return resolveSelection(snapshot, selection).headOffset
  }

  private applyFoldStateChange(operation: FoldOperation, fold: FoldRange): boolean {
    if (operation === 'fold') return this.foldState.fold(fold)
    if (operation === 'unfold') return this.foldState.unfold(fold)
    return this.foldState.toggleFold(fold)
  }

  private clearSyntaxFolds(): void {
    this.foldState.clear()
  }

  private applyResolvedTheme(): void {
    this.view.setTheme(this.resolvedTheme())
  }

  private resolvedTheme(): EditorTheme | null {
    return mergeEditorThemes(this.syntax.providerTheme, this.syntax.theme, this.configuredTheme)
  }
}

function mergeRowDecorationMap(
  target: Map<number, VirtualizedTextRowDecoration>,
  source: ReadonlyMap<number, VirtualizedTextRowDecoration>,
): void {
  for (const [row, decoration] of source) {
    target.set(row, mergeRowDecoration(target.get(row), decoration))
  }
}

function projectRowDecorationMapThroughLineEdit(
  source: ReadonlyMap<number, VirtualizedTextRowDecoration>,
  startRow: number,
  endRow: number,
  rowDelta: number,
): Map<number, VirtualizedTextRowDecoration> {
  const projected = new Map<number, VirtualizedTextRowDecoration>()
  for (const [row, decoration] of source) {
    if (row < startRow) {
      projected.set(row, decoration)
      continue
    }

    if (row === startRow) {
      projected.set(row, decoration)
      continue
    }

    if (row > endRow) projected.set(Math.max(0, row + rowDelta), decoration)
  }

  return projected
}

function editLineDelta(edit: TextEdit, previousText: TextSnapshot): number {
  return countLineBreaks(edit.text) - countLineBreaks(previousText.readRange(edit.from, edit.to))
}

function countLineBreaks(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') count += 1
  }
  return count
}

function rowForOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0
  let high = lineStarts.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle + 1
      continue
    }

    high = middle
  }

  return Math.max(0, low - 1)
}

function syntaxScrollDirection(delta: number): SyntaxScrollDirection {
  if (delta > 0) return 1
  if (delta < 0) return -1
  return 0
}

function sameInjectedTextRows(
  left: readonly InjectedTextRow[],
  right: readonly InjectedTextRow[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((row, index) => row === right[index])
}

function mergeRowDecoration(
  base: VirtualizedTextRowDecoration | undefined,
  next: VirtualizedTextRowDecoration,
): VirtualizedTextRowDecoration {
  if (!base) return next

  return {
    className: joinClassNames(base.className, next.className),
    gutterClassName: joinClassNames(base.gutterClassName, next.gutterClassName),
  }
}

function joinClassNames(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right
  if (!right) return left
  return `${left} ${right}`
}
