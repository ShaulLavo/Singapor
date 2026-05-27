export {
  clientSupportsDidSave,
  defaultClientCapabilities,
  documentSyncModeFromCapabilities,
  documentSyncOptionsFromCapabilities,
} from './capabilities'
export { LspClient, type LspClientConfig, type LspClientState } from './client'
export {
  createLspContentChanges,
  createLspContentChangesInSnapshot,
  lspPositionToOffset,
  lspPositionToOffsetInSnapshot,
  offsetToLspPosition,
  offsetToLspPositionInSnapshot,
  textEditsToLspContentChanges,
  textEditsToLspContentChangesInSnapshot,
  textEditToLspContentChange,
  textEditToLspContentChangeInSnapshot,
  type LspContentChangeOptions,
} from './positions'
export {
  createLspPlugin,
  type LspPluginDocumentUriResolver,
  type LspPluginLanguageIdResolver,
  type LspPluginOptions,
  type LspPluginRoute,
  type LspPluginStatus,
} from './plugin'
export {
  LspRequestCancelledError,
  LspResponseError,
  METHOD_NOT_FOUND,
  REQUEST_CANCELLED,
} from './protocol'
export {
  createWebSocketLspTransport,
  createWorkerLspTransport,
  type LspManagedTransport,
  type LspWebSocketConstructor,
  type LspWebSocketLike,
  type LspWebSocketTransportOptions,
  type LspWorkerLike,
  type LspWorkerMessageFormat,
  type LspWorkerTransportOptions,
} from './transports'
export type {
  LspDocument,
  LspDocumentChange,
  LspDocumentSaveSync,
  LspDocumentOpenOptions,
  LspDocumentSyncMode,
  LspDocumentSyncOptions,
  LspNotificationHandler,
  LspRequestHandle,
  LspServerMessageHandler,
  LspServerMessageNotification,
  PublishDiagnosticsNotificationParams,
  LspTextDocumentSnapshot,
  LspTextEdit,
  LspTextSnapshot,
  LspTransport,
  LspTransportHandler,
  LspUnhandledNotificationHandler,
  LspWorkspaceSyncTarget,
  LspWorkspaceEditOptions,
  LspWorkspaceSnapshotEditOptions,
} from './types'
export { LspWorkspace } from './workspace'
export type * as lsp from 'vscode-languageserver-protocol'
