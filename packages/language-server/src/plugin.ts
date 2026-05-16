import type {
  DocumentSessionChange,
  EditorCommandId,
  EditorDisposable,
  EditorFeatureContribution,
  EditorFeatureContributionContext,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from "@editor/core"

import {
  LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE_ID,
  type LanguageServerCompletionApplication,
  type LanguageServerCompletionEditFeature,
} from "./completion"
import { CompletionController } from "./completionController"
import { DiagnosticsPresenter } from "./diagnosticsPresenter"
import { DocumentSync } from "./documentSync"
import { HoverDefinitionController } from "./hoverDefinitionController"
import { LspConnection } from "./lspConnection"
import type {
  DiagnosticMarkerDirection,
  LanguageServerNavigationCommand,
  LanguageServerResolvedOptions,
} from "./pluginTypes"
import type {
  LanguageServerPlugin,
  LanguageServerPluginOptions,
} from "./types"

export type { LanguageServerResolvedOptions } from "./pluginTypes"

const DEFAULT_TIMEOUT_MS = 15000

export function createLanguageServerPlugin(
  options: LanguageServerPluginOptions,
): LanguageServerPlugin {
  const resolved = resolveOptions(options)
  const state = new LanguageServerPluginState()

  return {
    name: "editor.language-server",
    activate(context) {
      return [
        context.registerViewContribution({
          createContribution: (contributionContext) =>
            new LanguageServerContribution(contributionContext, state, resolved),
        }),
        context.registerEditorFeatureContribution({
          createContribution: (contributionContext) =>
            new LanguageServerCommandContribution(contributionContext, state),
        }),
      ]
    },
  }
}

class LanguageServerPluginState {
  private readonly contributions = new Set<LanguageServerContribution>()

  public register(contribution: LanguageServerContribution): void {
    this.contributions.add(contribution)
  }

  public unregister(contribution: LanguageServerContribution): void {
    this.contributions.delete(contribution)
  }

  public goToDefinitionFromSelection(): boolean {
    return this.runNavigationCommand({
      kind: "definition",
      openMode: "default",
    })
  }

  public runNavigationCommand(command: LanguageServerNavigationCommand): boolean {
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
}

class LanguageServerCommandContribution implements EditorFeatureContribution {
  private readonly commands: readonly EditorDisposable[]
  private readonly completionFeature: EditorDisposable

  public constructor(
    context: EditorFeatureContributionContext,
    private readonly state: LanguageServerPluginState,
  ) {
    this.commands = LANGUAGE_SERVER_COMMANDS.map((command) =>
      context.registerCommand(command.id, () => command.run(this.state)),
    )
    this.completionFeature = context.registerFeature(
      LANGUAGE_SERVER_COMPLETION_EDIT_FEATURE_ID,
      completionEditFeature(context),
    )
  }

  public dispose(): void {
    for (const command of this.commands) command.dispose()
    this.completionFeature.dispose()
  }
}

class LanguageServerContribution implements EditorViewContribution {
  private readonly connection: LspConnection
  private readonly diagnostics: DiagnosticsPresenter
  private readonly documentSync: DocumentSync
  private readonly completion: CompletionController
  private readonly hoverDefinition: HoverDefinitionController
  private disposed = false

  public constructor(
    context: EditorViewContributionContext,
    private readonly state: LanguageServerPluginState,
    private readonly options: LanguageServerResolvedOptions,
  ) {
    const prefix = context.highlightPrefix ?? "editor-language-server"
    this.diagnostics = new DiagnosticsPresenter(context, prefix, options.onDiagnostics)
    this.connection = new LspConnection(options, {
      onConnected: () => undefined,
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
    this.update(context.getSnapshot(), "document", null)
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

  public goToDefinitionFromSelection(): boolean {
    return this.runNavigationCommand({
      kind: "definition",
      openMode: "default",
    })
  }

  public runNavigationCommand(command: LanguageServerNavigationCommand): boolean {
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
): LanguageServerCompletionEditFeature {
  return {
    applyCompletion(application: LanguageServerCompletionApplication): boolean {
      if (!context.hasDocument()) return false

      context.applyEdits(
        application.edits,
        "languageServer.completion.accept",
        application.selection,
      )
      context.focusEditor()
      return true
    },
  }
}

function resolveOptions(options: LanguageServerPluginOptions): LanguageServerResolvedOptions {
  return {
    rootUri: options.rootUri ?? "file:///",
    hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground ?? false,
    initializationOptions: options.initializationOptions,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    webSocketRoute: options.webSocketRoute,
    webSocketTransportOptions: options.webSocketTransportOptions,
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onError: options.onError,
  }
}

const LANGUAGE_SERVER_COMMANDS: readonly {
  readonly id: EditorCommandId
  run(state: LanguageServerPluginState): boolean
}[] = [
  {
    id: "goToDefinition",
    run: (state) => state.goToDefinitionFromSelection(),
  },
  {
    id: "editor.action.goToDefinition",
    run: (state) => state.goToDefinitionFromSelection(),
  },
  {
    id: "editor.action.peekDefinition",
    run: (state) => state.runNavigationCommand({ kind: "definition", openMode: "peek" }),
  },
  {
    id: "editor.action.revealDefinitionAside",
    run: (state) => state.runNavigationCommand({ kind: "definition", openMode: "aside" }),
  },
  {
    id: "editor.action.goToImplementation",
    run: (state) =>
      state.runNavigationCommand({
        kind: "implementation",
        openMode: "default",
      }),
  },
  {
    id: "editor.action.goToTypeDefinition",
    run: (state) =>
      state.runNavigationCommand({
        kind: "typeDefinition",
        openMode: "default",
      }),
  },
  {
    id: "editor.action.goToReferences",
    run: (state) =>
      state.runNavigationCommand({
        kind: "references",
        openMode: "peek",
        includeDeclaration: true,
      }),
  },
  {
    id: "editor.action.marker.next",
    run: (state) => state.moveDiagnosticMarker("next"),
  },
  {
    id: "editor.action.marker.prev",
    run: (state) => state.moveDiagnosticMarker("previous"),
  },
]

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (!isRecord(error)) return false
  return error.name === "LspRequestCancelledError"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
