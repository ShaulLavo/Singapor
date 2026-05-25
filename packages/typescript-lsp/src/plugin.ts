import type { EditorCommandId } from '@editor/core/editor'
import type { DocumentSessionChange } from '@editor/core/document'
import type {
  EditorDisposable,
  EditorFeatureContribution,
  EditorFeatureContributionContext,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@editor/core/extensions'

import {
  TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE,
  type TypeScriptLspCompletionApplication,
  type TypeScriptLspCompletionEditFeature,
} from './completion'
import { CompletionController } from './completionController'
import { DiagnosticsPresenter } from './diagnosticsPresenter'
import { DocumentSync } from './documentSync'
import { HoverDefinitionController } from './hoverDefinitionController'
import { LspConnection } from './lspConnection'
import type {
  DiagnosticMarkerDirection,
  TypeScriptLspNavigationCommand,
  TypeScriptLspResolvedOptions,
} from './pluginTypes'
import type {
  TypeScriptLspPlugin,
  TypeScriptLspPluginOptions,
  TypeScriptLspSourceFile,
} from './types'

export type { TypeScriptLspResolvedOptions } from './pluginTypes'

const DEFAULT_DIAGNOSTIC_DELAY_MS = 150
const DEFAULT_TIMEOUT_MS = 15000

export function createTypeScriptLspPlugin(
  options: TypeScriptLspPluginOptions = {},
): TypeScriptLspPlugin {
  const resolved = resolveOptions(options)
  const state = new TypeScriptLspPluginState()

  return {
    name: 'editor.typescript-lsp',
    setWorkspaceFiles: (files) => state.setWorkspaceFiles(files),
    clearWorkspaceFiles: () => state.clearWorkspaceFiles(),
    activate(context) {
      return [
        context.registerViewContribution({
          createContribution: (contributionContext) =>
            new TypeScriptLspContribution(contributionContext, state, resolved),
        }),
        context.registerEditorFeatureContribution({
          createContribution: (contributionContext) =>
            new TypeScriptLspCommandContribution(contributionContext, state),
        }),
      ]
    },
  }
}

class TypeScriptLspPluginState {
  private readonly contributions = new Set<TypeScriptLspContribution>()
  private files: readonly TypeScriptLspSourceFile[] = []

  public get workspaceFiles(): readonly TypeScriptLspSourceFile[] {
    return this.files
  }

  public setWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void {
    this.files = files.map((file) => ({ path: file.path, text: file.text }))
    this.notifyWorkspaceFilesChanged()
  }

  public clearWorkspaceFiles(): void {
    this.files = []
    this.notifyWorkspaceFilesChanged()
  }

  public register(contribution: TypeScriptLspContribution): void {
    this.contributions.add(contribution)
  }

  public unregister(contribution: TypeScriptLspContribution): void {
    this.contributions.delete(contribution)
  }

  public goToDefinitionFromSelection(): boolean {
    return this.runNavigationCommand({
      kind: 'definition',
      openMode: 'default',
    })
  }

  public runNavigationCommand(command: TypeScriptLspNavigationCommand): boolean {
    for (const contribution of this.contributions) {
      if (contribution.runNavigationCommand(command)) return true
    }

    return false
  }

  public moveDiagnosticMarker(direction: DiagnosticMarkerDirection): boolean {
    for (const contribution of this.contributions) {
      if (contribution.moveDiagnosticMarker(direction)) return true
    }

    return false
  }

  private notifyWorkspaceFilesChanged(): void {
    for (const contribution of this.contributions) contribution.syncWorkspaceFiles()
  }
}

class TypeScriptLspCommandContribution implements EditorFeatureContribution {
  private readonly commands: readonly EditorDisposable[]
  private readonly completionFeature: EditorDisposable

  public constructor(
    context: EditorFeatureContributionContext,
    private readonly state: TypeScriptLspPluginState,
  ) {
    this.commands = TYPESCRIPT_LSP_COMMANDS.map((command) =>
      context.registerCommand(command.id, () => command.run(this.state)),
    )
    this.completionFeature = context.registerFeature(
      TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE,
      completionEditFeature(context),
    )
  }

  public dispose(): void {
    for (const command of this.commands) command.dispose()
    this.completionFeature.dispose()
  }
}

class TypeScriptLspContribution implements EditorViewContribution {
  private readonly connection: LspConnection
  private readonly diagnostics: DiagnosticsPresenter
  private readonly documentSync: DocumentSync
  private readonly completion: CompletionController
  private readonly hoverDefinition: HoverDefinitionController
  private disposed = false

  public constructor(
    context: EditorViewContributionContext,
    private readonly state: TypeScriptLspPluginState,
    private readonly options: TypeScriptLspResolvedOptions,
  ) {
    const prefix = context.highlightPrefix ?? 'editor-typescript-lsp'
    this.diagnostics = new DiagnosticsPresenter(context, prefix, options.onDiagnostics)
    this.connection = new LspConnection(options, {
      onConnected: () => this.syncWorkspaceFiles(),
      onUnavailable: () => this.clearRequestUi(),
      onPublishDiagnostics: (params) => this.documentSync.publishDiagnostics(params),
      onStatusChange: options.onStatusChange,
      onError: options.onError,
    })
    this.documentSync = new DocumentSync(this.connection.workspace, this.diagnostics, {
      onDocumentClosed: () => this.completion.hide(),
    })
    this.completion = new CompletionController({
      context,
      client: this.connection.client,
      getActiveDocument: () => this.documentSync.activeDocument,
      ignorePointerTarget: (target) => this.hoverDefinition.containsTarget(target),
      onBeforeShow: () => this.hoverDefinition.clearPointerUi(),
      onRequestError: (error) => this.handleRequestError(error),
    })
    this.hoverDefinition = new HoverDefinitionController({
      context,
      client: this.connection.client,
      hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground,
      getActiveDocument: () => this.documentSync.activeDocument,
      getDiagnostics: () => this.documentSync.diagnostics,
      completionContainsTarget: (target) => this.completion.containsTarget(target),
      onOpenDefinition: options.onOpenDefinition,
      onOpenReferences: options.onOpenReferences,
      onRequestError: (error) => this.handleRequestError(error),
    })
    this.state.register(this)
    this.connection.connect()
    this.update(context.getSnapshot(), 'document', null)
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    if (this.disposed) return

    this.hoverDefinition.update(snapshot, kind)
    if (this.documentSync.shouldSync(kind, snapshot))
      this.documentSync.sync(snapshot, change ?? null)
    this.completion.update(snapshot, kind, change ?? null)
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.state.unregister(this)
    this.hoverDefinition.dispose()
    this.completion.hide()
    this.documentSync.close()
    this.completion.dispose()
    this.connection.dispose()
  }

  public syncWorkspaceFiles(): void {
    if (this.disposed) return

    this.connection.syncWorkspaceFiles(this.state.workspaceFiles)
  }

  public goToDefinitionFromSelection(): boolean {
    return this.runNavigationCommand({
      kind: 'definition',
      openMode: 'default',
    })
  }

  public runNavigationCommand(command: TypeScriptLspNavigationCommand): boolean {
    return this.hoverDefinition.runNavigationCommand(command)
  }

  public moveDiagnosticMarker(direction: DiagnosticMarkerDirection): boolean {
    return this.diagnostics.moveMarker(
      this.documentSync.activeDocument,
      this.documentSync.diagnostics,
      direction,
    )
  }

  private clearRequestUi(): void {
    this.hoverDefinition.clearPointerUi()
    this.completion.hide()
  }

  private handleRequestError(error: unknown): void {
    if (isAbortError(error)) return
    this.options.onError?.(error)
  }
}

function completionEditFeature(
  context: EditorFeatureContributionContext,
): TypeScriptLspCompletionEditFeature {
  return {
    applyCompletion(application: TypeScriptLspCompletionApplication): boolean {
      if (!context.hasDocument()) return false

      context.applyEdits(
        application.edits,
        'typescriptLsp.completion.accept',
        application.selection,
      )
      context.focusEditor()
      return true
    },
  }
}

function resolveOptions(options: TypeScriptLspPluginOptions): TypeScriptLspResolvedOptions {
  return {
    rootUri: options.rootUri ?? 'file:///',
    compilerOptions: options.compilerOptions,
    diagnosticDelayMs: options.diagnosticDelayMs ?? DEFAULT_DIAGNOSTIC_DELAY_MS,
    hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground ?? false,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workerFactory: options.workerFactory,
    webSocketRoute: options.webSocketRoute,
    webSocketTransportOptions: options.webSocketTransportOptions,
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onError: options.onError,
  }
}

const TYPESCRIPT_LSP_COMMANDS: readonly {
  readonly id: EditorCommandId
  run(state: TypeScriptLspPluginState): boolean
}[] = [
  {
    id: 'goToDefinition',
    run: (state) => state.goToDefinitionFromSelection(),
  },
  {
    id: 'editor.action.goToDefinition',
    run: (state) => state.goToDefinitionFromSelection(),
  },
  {
    id: 'editor.action.peekDefinition',
    run: (state) => state.runNavigationCommand({ kind: 'definition', openMode: 'peek' }),
  },
  {
    id: 'editor.action.revealDefinitionAside',
    run: (state) => state.runNavigationCommand({ kind: 'definition', openMode: 'aside' }),
  },
  {
    id: 'editor.action.goToImplementation',
    run: (state) =>
      state.runNavigationCommand({
        kind: 'implementation',
        openMode: 'default',
      }),
  },
  {
    id: 'editor.action.goToTypeDefinition',
    run: (state) =>
      state.runNavigationCommand({
        kind: 'typeDefinition',
        openMode: 'default',
      }),
  },
  {
    id: 'editor.action.goToReferences',
    run: (state) =>
      state.runNavigationCommand({
        kind: 'references',
        openMode: 'peek',
        includeDeclaration: true,
      }),
  },
  {
    id: 'editor.action.marker.next',
    run: (state) => state.moveDiagnosticMarker('next'),
  },
  {
    id: 'editor.action.marker.prev',
    run: (state) => state.moveDiagnosticMarker('previous'),
  },
]

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (!isRecord(error)) return false
  return error.name === 'LspRequestCancelledError'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
