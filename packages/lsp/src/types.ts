import type * as lsp from 'vscode-languageserver-protocol'

export type LspTransportHandler = (message: string) => void

export type LspTransport = {
  send(message: string): void
  subscribe(handler: LspTransportHandler): void
  unsubscribe(handler: LspTransportHandler): void
}

export type LspTextEdit = {
  readonly from: number
  readonly to: number
  readonly text: string
}

export type LspTextSnapshot = {
  readonly length: number
  getText(): string
  getTextInRange(start: number, end?: number): string
}

export type LspTextDocumentSnapshot = {
  readonly textSnapshot: LspTextSnapshot
  readonly lineStarts: readonly number[]
}

export type LspDocumentSyncMode = 'none' | 'full' | 'incremental'

export type LspDocumentOpenOptions = {
  readonly uri: lsp.DocumentUri
  readonly languageId: string
  readonly text: string
}

export type LspDocument = LspDocumentOpenOptions & {
  readonly version: number
  readonly textSnapshot: LspTextSnapshot
  readonly lineStarts: readonly number[]
}

export type LspWorkspaceEditOptions = {
  readonly edits?: readonly LspTextEdit[]
}

export type LspWorkspaceSnapshotEditOptions = LspTextDocumentSnapshot & {
  readonly edits?: readonly LspTextEdit[]
}

export type PublishDiagnosticsNotificationParams = {
  readonly uri: lsp.DocumentUri
  readonly version?: number
  readonly diagnostics: readonly lsp.Diagnostic[]
}

export type LspNotificationHandler<TClient = unknown> = (
  client: TClient,
  params: unknown,
  message: lsp.NotificationMessage,
) => boolean | void

export type LspUnhandledNotificationHandler<TClient = unknown> = (
  client: TClient,
  method: string,
  params: unknown,
  message: lsp.NotificationMessage,
) => void
