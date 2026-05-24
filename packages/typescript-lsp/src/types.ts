import type { EditorPlugin } from '@editor/core'
import type { LspWebSocketTransportOptions, LspWorkerLike } from '@editor/lsp'
import type ts from 'typescript'
import type * as lsp from 'vscode-languageserver-protocol'

export type TypeScriptLspSourceFile = {
  readonly path: string
  readonly text: string
}

export type TypeScriptLspStatus = 'idle' | 'loading' | 'ready' | 'error'

export type TypeScriptLspDiagnosticCounts = {
  readonly error: number
  readonly warning: number
  readonly information: number
  readonly hint: number
  readonly total: number
}

export type TypeScriptLspDiagnosticSummary = {
  readonly uri: lsp.DocumentUri | null
  readonly version: number | null
  readonly diagnostics: readonly lsp.Diagnostic[]
  readonly counts: TypeScriptLspDiagnosticCounts
}

export type TypeScriptLspDefinitionTarget = {
  readonly uri: lsp.DocumentUri
  readonly path: string
  readonly range: lsp.Range
}

export type TypeScriptLspNavigationKind =
  | 'definition'
  | 'references'
  | 'implementation'
  | 'typeDefinition'

export type TypeScriptLspNavigationOpenMode = 'default' | 'peek' | 'aside'

export type TypeScriptLspNavigationOptions = {
  readonly kind: TypeScriptLspNavigationKind
  readonly openMode: TypeScriptLspNavigationOpenMode
}

export type TypeScriptLspReferencesResult = {
  readonly uri: lsp.DocumentUri
  readonly targets: readonly TypeScriptLspDefinitionTarget[]
}

export type TypeScriptLspPluginOptions = {
  readonly rootUri?: lsp.DocumentUri | null
  readonly compilerOptions?: ts.CompilerOptions
  readonly diagnosticDelayMs?: number
  readonly hoverMarkdownCodeBackground?: boolean
  readonly timeoutMs?: number
  readonly workerFactory?: () => LspWorkerLike
  readonly webSocketRoute?: string | URL
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions
  readonly onStatusChange?: (status: TypeScriptLspStatus) => void
  readonly onDiagnostics?: (summary: TypeScriptLspDiagnosticSummary) => void
  readonly onOpenDefinition?: (
    target: TypeScriptLspDefinitionTarget,
    options?: TypeScriptLspNavigationOptions,
  ) => void | boolean
  readonly onOpenReferences?: (result: TypeScriptLspReferencesResult) => void | boolean
  readonly onError?: (error: unknown) => void
}

export type TypeScriptLspPlugin = EditorPlugin & {
  setWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void
  clearWorkspaceFiles(): void
}
