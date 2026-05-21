import type { LspWebSocketTransportOptions, LspWorkerLike } from "@editor/lsp";
import type * as lsp from "vscode-languageserver-protocol";

import type {
  TypeScriptLspDefinitionTarget,
  TypeScriptLspDiagnosticSummary,
  TypeScriptLspNavigationKind,
  TypeScriptLspNavigationOpenMode,
  TypeScriptLspNavigationOptions,
  TypeScriptLspPluginOptions,
  TypeScriptLspReferencesResult,
  TypeScriptLspStatus,
} from "./types";

export type TypeScriptLspResolvedOptions = {
  readonly rootUri: lsp.DocumentUri | null;
  readonly compilerOptions: TypeScriptLspPluginOptions["compilerOptions"];
  readonly diagnosticDelayMs: number;
  readonly hoverMarkdownCodeBackground: boolean;
  readonly timeoutMs: number;
  readonly workerFactory?: () => LspWorkerLike;
  readonly webSocketRoute?: string | URL;
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions;
  readonly onStatusChange?: (status: TypeScriptLspStatus) => void;
  readonly onDiagnostics?: (summary: TypeScriptLspDiagnosticSummary) => void;
  readonly onOpenDefinition?: (
    target: TypeScriptLspDefinitionTarget,
    options?: TypeScriptLspNavigationOptions,
  ) => void | boolean;
  readonly onOpenReferences?: (result: TypeScriptLspReferencesResult) => void | boolean;
  readonly onError?: (error: unknown) => void;
};

export type TypeScriptLspNavigationCommand = {
  readonly kind: TypeScriptLspNavigationKind;
  readonly openMode: TypeScriptLspNavigationOpenMode;
  readonly includeDeclaration?: boolean;
};

export type DiagnosticMarkerDirection = "next" | "previous";

export type ActiveDocument = {
  readonly uri: lsp.DocumentUri;
  readonly languageId: string;
  readonly text: string;
  readonly textVersion: number;
  readonly lspVersion: number;
};

export type DocumentDescriptor = {
  readonly uri: lsp.DocumentUri;
  readonly languageId: string;
  readonly text: string;
  readonly textVersion: number;
};
