import type { DocumentSessionChange } from './documentSession'
import type { DocumentTextSnapshot, TextSnapshot } from './documentTextSnapshot'
import type { EditorCommandContext, EditorCommandId } from './editor/commands'
import type { PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import type { EditorTheme } from './theme'
import type { EditorToken, TextEdit } from './tokens'
import type { EditorBlockProvider } from './editorBlocks'
import type { DisplayTextRowSource, InjectedTextRow } from './displayTransforms'
import {
  type EditorSyntaxLanguageId,
  type EditorSyntaxProvider,
  type EditorSyntaxSession,
  type EditorSyntaxSessionOptions,
} from './syntax/session'
import type { BrowserTextMetrics } from './virtualization/browserMetrics'
import type { FixedRowVisibleRange } from './virtualization/fixedRowVirtualizer'
import type {
  EditorCursorLineHighlightOptions,
  VirtualizedFoldMarker,
  VirtualizedTextHighlightStyle,
  VirtualizedTextRowDecoration,
} from './virtualization/virtualizedTextViewTypes'

export type EditorDisposable = {
  dispose(): void
}

export const EDITOR_MINIMAP_FEATURE_ID = 'editor.minimap'

export type EditorMinimapDecorationPosition = 'inline' | 'gutter'
export type EditorMinimapSectionHeaderStyle = 'normal' | 'underlined'

export type EditorMinimapDecoration = {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
  readonly color?: string
  readonly position: EditorMinimapDecorationPosition
  readonly sectionHeaderStyle?: EditorMinimapSectionHeaderStyle | null
  readonly sectionHeaderText?: string | null
  readonly zIndex?: number
}

export type EditorMinimapFeature = {
  setDecorations(sourceId: string, decorations: readonly EditorMinimapDecoration[]): void
  clearDecorations(sourceId: string): void
  getDecorations(): readonly EditorMinimapDecoration[]
  subscribe(listener: () => void): EditorDisposable
}

export type EditorHighlightResult = {
  readonly tokens: readonly EditorToken[]
  readonly theme?: EditorTheme | null
}

export type EditorHighlighterSessionOptions = {
  readonly documentId: string
  readonly languageId: EditorSyntaxLanguageId | null
  readonly fullText: string
  readonly textSnapshot?: DocumentTextSnapshot
  readonly snapshot: PieceTableSnapshot
}

export type EditorHighlighterSession = EditorDisposable & {
  refresh(snapshot: PieceTableSnapshot, fullText?: string): Promise<EditorHighlightResult>
  applyChange(change: DocumentSessionChange): Promise<EditorHighlightResult>
}

export type EditorHighlighterProvider = {
  loadTheme?(): Promise<EditorTheme | null | undefined>
  createSession(options: EditorHighlighterSessionOptions): EditorHighlighterSession | null
}

export type EditorResolvedSelection = {
  readonly anchorOffset: number
  readonly headOffset: number
  readonly startOffset: number
  readonly endOffset: number
}

export type EditorViewportSnapshot = {
  readonly scrollTop: number
  readonly scrollLeft: number
  readonly scrollHeight: number
  readonly scrollWidth: number
  readonly clientHeight: number
  readonly clientWidth: number
  readonly borderBoxHeight?: number
  readonly borderBoxWidth?: number
  readonly visibleRange: FixedRowVisibleRange
}

export type EditorVisibleRowSnapshot = {
  readonly index: number
  readonly bufferRow: number
  readonly source: DisplayTextRowSource | 'block'
  readonly injectedTextRowId?: string
  readonly metadata?: unknown
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly kind: 'text' | 'block'
  readonly primaryText: boolean
  readonly top: number
  readonly height: number
}

export type EditorViewSnapshot = {
  readonly documentId: string | null
  readonly languageId: EditorSyntaxLanguageId | null
  readonly theme?: EditorTheme | null
  readonly textSnapshot?: TextSnapshot
  readonly fullText: string
  readonly textVersion: number
  readonly lineStarts: readonly number[]
  readonly tokens: readonly EditorToken[]
  readonly selections: readonly EditorResolvedSelection[]
  readonly metrics: BrowserTextMetrics
  readonly lineCount: number
  readonly contentWidth: number
  readonly totalHeight: number
  readonly tabSize: number
  readonly foldMarkers: readonly VirtualizedFoldMarker[]
  readonly visibleRows: readonly EditorVisibleRowSnapshot[]
  readonly viewport: EditorViewportSnapshot
}

export type EditorOverlaySide = 'left' | 'right'

export type EditorViewContributionContext = {
  readonly container: HTMLElement
  readonly scrollElement: HTMLDivElement
  readonly highlightPrefix?: string
  getSnapshot(): EditorViewSnapshot
  getFeature?<T>(id: string): T | null
  revealLine(row: number): void
  focusEditor(): void
  setSelection(anchor: number, head: number, timingName: string, revealOffset?: number): void
  setScrollTop(scrollTop: number): void
  reserveOverlayWidth(side: EditorOverlaySide, width: number): void
  textOffsetFromPoint(clientX: number, clientY: number): number | null
  getRangeClientRect(start: number, end: number): DOMRect | null
  setRangeHighlight?(
    name: string,
    ranges: readonly { readonly start: number; readonly end: number }[],
    style: VirtualizedTextHighlightStyle,
  ): void
  clearRangeHighlight?(name: string): void
}

export type EditorViewContributionUpdateKind =
  | 'document'
  | 'content'
  | 'tokens'
  | 'selection'
  | 'viewport'
  | 'layout'
  | 'clear'

export type EditorViewContribution = EditorDisposable & {
  update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void
}

export type EditorViewContributionProvider = {
  createContribution(context: EditorViewContributionContext): EditorViewContribution | null
}

export type EditorCommandHandler = (context: EditorCommandContext) => boolean

export type EditorSelectionRange = {
  readonly anchor: number
  readonly head: number
}

export type EditorFeatureContributionContext = {
  readonly container: HTMLElement
  readonly scrollElement: HTMLDivElement
  readonly highlightPrefix: string
  hasDocument(): boolean
  materializeFullText(): string
  getTextSnapshot?(): TextSnapshot | null
  getSelections(): readonly EditorResolvedSelection[]
  focusEditor(): void
  setSelection(anchor: number, head: number, timingName: string, revealOffset?: number): void
  setSelections(
    selections: readonly EditorSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void
  applyEdits(edits: readonly TextEdit[], timingName: string, selection?: EditorSelectionRange): void
  setRangeHighlight(
    name: string,
    ranges: readonly { readonly start: number; readonly end: number }[],
    style: VirtualizedTextHighlightStyle,
  ): void
  clearRangeHighlight(name: string): void
  setRowDecorations(
    sourceId: string,
    decorations: ReadonlyMap<number, VirtualizedTextRowDecoration>,
  ): void
  clearRowDecorations(sourceId: string): void
  registerCommand(command: EditorCommandId, handler: EditorCommandHandler): EditorDisposable
  registerFeature<T>(id: string, feature: T): EditorDisposable
}

export type EditorFeatureContribution = EditorDisposable & {
  handleEditorChange?(change: DocumentSessionChange | null): void
}

export type EditorFeatureContributionProvider = {
  createContribution(context: EditorFeatureContributionContext): EditorFeatureContribution | null
}

export type EditorGutterWidthContext = {
  readonly lineCount: number
  readonly metrics: BrowserTextMetrics
}

export type EditorGutterRowContext = {
  readonly index: number
  readonly bufferRow: number
  readonly source: DisplayTextRowSource | 'block'
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly kind: 'text' | 'block'
  readonly injectedTextRowId?: string
  readonly metadata?: unknown
  readonly primaryText: boolean
  readonly cursorLine: boolean
  readonly cursorLineHighlight: Required<EditorCursorLineHighlightOptions>
  readonly foldMarker: VirtualizedFoldMarker | null
  readonly lineCount: number
  toggleFold(marker: VirtualizedFoldMarker): void
}

export type EditorInjectedTextRow = InjectedTextRow

export type EditorInjectedTextRowProviderContext = {
  readonly documentId: string | null
  readonly text: string
  readonly lineCount: number
}

export type EditorInjectedTextRowProvider = {
  getInjectedTextRows(
    context: EditorInjectedTextRowProviderContext,
  ): readonly EditorInjectedTextRow[]
  onDidChangeInjectedTextRows?(listener: () => void): EditorDisposable
}

export type EditorGutterContribution = {
  readonly id: string
  readonly className?: string
  createCell(document: Document): HTMLElement
  width(context: EditorGutterWidthContext): number
  updateCell(element: HTMLElement, row: EditorGutterRowContext): void
  disposeCell?(element: HTMLElement): void
}

export type EditorPluginContext = {
  registerHighlighter(provider: EditorHighlighterProvider): EditorDisposable
  registerSyntaxProvider(provider: EditorSyntaxProvider): EditorDisposable
  registerViewContribution(provider: EditorViewContributionProvider): EditorDisposable
  registerEditorFeatureContribution(provider: EditorFeatureContributionProvider): EditorDisposable
  registerGutterContribution(contribution: EditorGutterContribution): EditorDisposable
  registerBlockProvider(provider: EditorBlockProvider): EditorDisposable
  registerInjectedTextRowProvider(provider: EditorInjectedTextRowProvider): EditorDisposable
}

export type EditorPlugin = {
  readonly name?: string
  activate(context: EditorPluginContext): void | EditorDisposable | readonly EditorDisposable[]
}

export type EditorPluginHostEvents = {
  onHighlighterProvidersChanged?(): void
  onSyntaxProvidersChanged?(): void
  onViewContributionProviderAdded?(provider: EditorViewContributionProvider): void
  onViewContributionProviderRemoved?(provider: EditorViewContributionProvider): void
  onEditorFeatureContributionProviderAdded?(provider: EditorFeatureContributionProvider): void
  onEditorFeatureContributionProviderRemoved?(provider: EditorFeatureContributionProvider): void
  onGutterContributionsChanged?(): void
  onBlockProvidersChanged?(): void
  onInjectedTextRowProvidersChanged?(): void
}

type ActiveEditorPlugin = {
  references: number
  disposable: EditorDisposable | null
}

export class EditorPluginHost implements EditorDisposable {
  private readonly highlighters: EditorHighlighterProvider[] = []
  private readonly syntaxProviders: EditorSyntaxProvider[] = []
  private readonly viewContributions: EditorViewContributionProvider[] = []
  private readonly editorFeatureContributions: EditorFeatureContributionProvider[] = []
  private readonly gutterContributions: EditorGutterContribution[] = []
  private readonly blockProviders: EditorBlockProvider[] = []
  private readonly injectedTextRowProviders: EditorInjectedTextRowProvider[] = []
  private readonly blockProviderInvalidationDisposables = new Map<
    EditorBlockProvider,
    EditorDisposable
  >()
  private readonly injectedTextRowProviderInvalidationDisposables = new Map<
    EditorInjectedTextRowProvider,
    EditorDisposable
  >()
  private readonly activePlugins = new Map<EditorPlugin, ActiveEditorPlugin>()
  private readonly managedPlugins = new Set<EditorPlugin>()
  private readonly manualPluginReferences = new Map<EditorPlugin, number>()
  private readonly context = this.createContext()
  private events: EditorPluginHostEvents = {}

  public constructor(plugins: readonly EditorPlugin[] = []) {
    this.setPlugins(plugins)
  }

  public setEvents(events: EditorPluginHostEvents): void {
    this.events = events
  }

  public addPlugin(plugin: EditorPlugin): EditorDisposable {
    this.retainPlugin(plugin)
    this.manualPluginReferences.set(plugin, this.manualReferenceCount(plugin) + 1)

    return disposableOnce(() => this.releaseManualPlugin(plugin))
  }

  public removePlugin(plugin: EditorPlugin): boolean {
    const removedManaged = this.removeManagedPlugin(plugin)
    const removedManual = this.removeManualPlugin(plugin)
    return removedManaged || removedManual
  }

  public setPlugins(plugins: readonly EditorPlugin[]): void {
    const nextPlugins = new Set(plugins)

    for (const plugin of this.managedPlugins) {
      if (nextPlugins.has(plugin)) continue

      this.managedPlugins.delete(plugin)
      this.releasePlugin(plugin)
    }

    for (const plugin of nextPlugins) {
      if (this.managedPlugins.has(plugin)) continue

      this.managedPlugins.add(plugin)
      this.retainPlugin(plugin)
    }
  }

  public createHighlighterSession(
    options: EditorHighlighterSessionOptions,
  ): EditorHighlighterSession | null {
    for (const provider of this.highlighters) {
      const session = provider.createSession(options)
      if (session) return session
    }

    return null
  }

  public hasHighlighterProviders(): boolean {
    return this.highlighters.length > 0
  }

  public async loadHighlighterTheme(): Promise<EditorTheme | null | undefined> {
    for (const provider of this.highlighters) {
      if (!provider.loadTheme) continue

      const theme = await provider.loadTheme()
      if (theme !== undefined) return theme
    }

    return undefined
  }

  public createSyntaxSession(options: EditorSyntaxSessionOptions): EditorSyntaxSession | null {
    for (const provider of this.syntaxProviders) {
      const session = provider.createSession(options)
      if (session) return session
    }

    return null
  }

  public hasSyntaxProviders(): boolean {
    return this.syntaxProviders.length > 0
  }

  public createViewContributions(context: EditorViewContributionContext): EditorViewContribution[] {
    const contributions: EditorViewContribution[] = []
    for (const provider of this.viewContributions) {
      const contribution = provider.createContribution(context)
      if (contribution) contributions.push(contribution)
    }

    return contributions
  }

  public createEditorFeatureContributions(
    context: EditorFeatureContributionContext,
  ): EditorFeatureContribution[] {
    const contributions: EditorFeatureContribution[] = []
    for (const provider of this.editorFeatureContributions) {
      const contribution = provider.createContribution(context)
      if (contribution) contributions.push(contribution)
    }

    return contributions
  }

  public getGutterContributions(): readonly EditorGutterContribution[] {
    return [...this.gutterContributions]
  }

  public getBlockProviders(): readonly EditorBlockProvider[] {
    return this.blockProviders
  }

  public getInjectedTextRowProviders(): readonly EditorInjectedTextRowProvider[] {
    return this.injectedTextRowProviders
  }

  public getViewContributionProviders(): readonly EditorViewContributionProvider[] {
    return this.viewContributions
  }

  public getEditorFeatureContributionProviders(): readonly EditorFeatureContributionProvider[] {
    return this.editorFeatureContributions
  }

  public dispose(): void {
    while (this.activePlugins.size > 0) {
      const plugin = this.activePlugins.keys().next().value
      if (!plugin) break

      this.disposeActivePlugin(plugin)
    }
    this.managedPlugins.clear()
    this.manualPluginReferences.clear()
    this.highlighters.length = 0
    this.syntaxProviders.length = 0
    this.viewContributions.length = 0
    this.editorFeatureContributions.length = 0
    this.gutterContributions.length = 0
    for (const disposable of this.blockProviderInvalidationDisposables.values()) {
      disposable.dispose()
    }
    this.blockProviderInvalidationDisposables.clear()
    this.blockProviders.length = 0
    for (const disposable of this.injectedTextRowProviderInvalidationDisposables.values()) {
      disposable.dispose()
    }
    this.injectedTextRowProviderInvalidationDisposables.clear()
    this.injectedTextRowProviders.length = 0
  }

  private retainPlugin(plugin: EditorPlugin): void {
    const activePlugin = this.activePlugins.get(plugin)
    if (activePlugin) {
      activePlugin.references += 1
      return
    }

    this.activePlugins.set(plugin, {
      references: 1,
      disposable: this.activatePlugin(plugin),
    })
  }

  private releasePlugin(plugin: EditorPlugin): void {
    const activePlugin = this.activePlugins.get(plugin)
    if (!activePlugin) return

    activePlugin.references -= 1
    if (activePlugin.references > 0) return

    this.disposeActivePlugin(plugin)
  }

  private activatePlugin(plugin: EditorPlugin): EditorDisposable | null {
    return disposableFromActivationResult(plugin.activate(this.context))
  }

  private disposeActivePlugin(plugin: EditorPlugin): void {
    const activePlugin = this.activePlugins.get(plugin)
    if (!activePlugin) return

    this.activePlugins.delete(plugin)
    activePlugin.disposable?.dispose()
  }

  private removeManagedPlugin(plugin: EditorPlugin): boolean {
    if (!this.managedPlugins.delete(plugin)) return false

    this.releasePlugin(plugin)
    return true
  }

  private removeManualPlugin(plugin: EditorPlugin): boolean {
    const references = this.manualReferenceCount(plugin)
    if (references === 0) return false

    this.manualPluginReferences.delete(plugin)
    for (let index = 0; index < references; index += 1) this.releasePlugin(plugin)
    return true
  }

  private releaseManualPlugin(plugin: EditorPlugin): void {
    const references = this.manualReferenceCount(plugin)
    if (references === 0) return

    this.setManualReferenceCount(plugin, references - 1)
    this.releasePlugin(plugin)
  }

  private manualReferenceCount(plugin: EditorPlugin): number {
    return this.manualPluginReferences.get(plugin) ?? 0
  }

  private setManualReferenceCount(plugin: EditorPlugin, references: number): void {
    if (references > 0) {
      this.manualPluginReferences.set(plugin, references)
      return
    }

    this.manualPluginReferences.delete(plugin)
  }

  private createContext(): EditorPluginContext {
    return {
      registerHighlighter: (provider) => this.registerHighlighter(provider),
      registerSyntaxProvider: (provider) => this.registerSyntaxProvider(provider),
      registerViewContribution: (provider) => this.registerViewContribution(provider),
      registerEditorFeatureContribution: (provider) =>
        this.registerEditorFeatureContribution(provider),
      registerGutterContribution: (contribution) => this.registerGutterContribution(contribution),
      registerBlockProvider: (provider) => this.registerBlockProvider(provider),
      registerInjectedTextRowProvider: (provider) => this.registerInjectedTextRowProvider(provider),
    }
  }

  private registerHighlighter(provider: EditorHighlighterProvider): EditorDisposable {
    this.highlighters.push(provider)
    this.events.onHighlighterProvidersChanged?.()

    return {
      dispose: () => this.unregisterHighlighter(provider),
    }
  }

  private unregisterHighlighter(provider: EditorHighlighterProvider): void {
    const index = this.highlighters.indexOf(provider)
    if (index === -1) return

    this.highlighters.splice(index, 1)
    this.events.onHighlighterProvidersChanged?.()
  }

  private registerSyntaxProvider(provider: EditorSyntaxProvider): EditorDisposable {
    this.syntaxProviders.push(provider)
    this.events.onSyntaxProvidersChanged?.()

    return {
      dispose: () => this.unregisterSyntaxProvider(provider),
    }
  }

  private unregisterSyntaxProvider(provider: EditorSyntaxProvider): void {
    const index = this.syntaxProviders.indexOf(provider)
    if (index === -1) return

    this.syntaxProviders.splice(index, 1)
    this.events.onSyntaxProvidersChanged?.()
  }

  private registerViewContribution(provider: EditorViewContributionProvider): EditorDisposable {
    this.viewContributions.push(provider)
    this.events.onViewContributionProviderAdded?.(provider)

    return {
      dispose: () => this.unregisterViewContribution(provider),
    }
  }

  private unregisterViewContribution(provider: EditorViewContributionProvider): void {
    const index = this.viewContributions.indexOf(provider)
    if (index === -1) return

    this.viewContributions.splice(index, 1)
    this.events.onViewContributionProviderRemoved?.(provider)
  }

  private registerEditorFeatureContribution(
    provider: EditorFeatureContributionProvider,
  ): EditorDisposable {
    this.editorFeatureContributions.push(provider)
    this.events.onEditorFeatureContributionProviderAdded?.(provider)

    return {
      dispose: () => this.unregisterEditorFeatureContribution(provider),
    }
  }

  private unregisterEditorFeatureContribution(provider: EditorFeatureContributionProvider): void {
    const index = this.editorFeatureContributions.indexOf(provider)
    if (index === -1) return

    this.editorFeatureContributions.splice(index, 1)
    this.events.onEditorFeatureContributionProviderRemoved?.(provider)
  }

  private registerGutterContribution(contribution: EditorGutterContribution): EditorDisposable {
    this.gutterContributions.push(contribution)
    this.events.onGutterContributionsChanged?.()

    return {
      dispose: () => this.unregisterGutterContribution(contribution),
    }
  }

  private unregisterGutterContribution(contribution: EditorGutterContribution): void {
    const index = this.gutterContributions.indexOf(contribution)
    if (index === -1) return

    this.gutterContributions.splice(index, 1)
    this.events.onGutterContributionsChanged?.()
  }

  private registerBlockProvider(provider: EditorBlockProvider): EditorDisposable {
    this.blockProviders.push(provider)
    const invalidationDisposable = provider.onDidChangeBlocks?.(() => {
      this.events.onBlockProvidersChanged?.()
    })
    if (invalidationDisposable) {
      this.blockProviderInvalidationDisposables.set(provider, invalidationDisposable)
    }
    this.events.onBlockProvidersChanged?.()

    return {
      dispose: () => this.unregisterBlockProvider(provider),
    }
  }

  private unregisterBlockProvider(provider: EditorBlockProvider): void {
    const index = this.blockProviders.indexOf(provider)
    if (index === -1) return

    this.blockProviders.splice(index, 1)
    this.blockProviderInvalidationDisposables.get(provider)?.dispose()
    this.blockProviderInvalidationDisposables.delete(provider)
    this.events.onBlockProvidersChanged?.()
  }

  private registerInjectedTextRowProvider(
    provider: EditorInjectedTextRowProvider,
  ): EditorDisposable {
    this.injectedTextRowProviders.push(provider)
    const invalidationDisposable = provider.onDidChangeInjectedTextRows?.(() => {
      this.events.onInjectedTextRowProvidersChanged?.()
    })
    if (invalidationDisposable) {
      this.injectedTextRowProviderInvalidationDisposables.set(provider, invalidationDisposable)
    }
    this.events.onInjectedTextRowProvidersChanged?.()

    return {
      dispose: () => this.unregisterInjectedTextRowProvider(provider),
    }
  }

  private unregisterInjectedTextRowProvider(provider: EditorInjectedTextRowProvider): void {
    const index = this.injectedTextRowProviders.indexOf(provider)
    if (index === -1) return

    this.injectedTextRowProviders.splice(index, 1)
    this.injectedTextRowProviderInvalidationDisposables.get(provider)?.dispose()
    this.injectedTextRowProviderInvalidationDisposables.delete(provider)
    this.events.onInjectedTextRowProvidersChanged?.()
  }
}

function disposableFromActivationResult(
  result: void | EditorDisposable | readonly EditorDisposable[],
): EditorDisposable | null {
  if (!result) return null
  if (!isDisposableList(result)) return result

  return {
    dispose: () => disposeAll(result),
  }
}

function disposeAll(disposables: readonly EditorDisposable[]): void {
  for (const disposable of disposables.toReversed()) disposable.dispose()
}

function disposableOnce(dispose: () => void): EditorDisposable {
  let disposed = false

  return {
    dispose() {
      if (disposed) return

      disposed = true
      dispose()
    },
  }
}

const isDisposableList = (
  value: EditorDisposable | readonly EditorDisposable[],
): value is readonly EditorDisposable[] => Array.isArray(value)
