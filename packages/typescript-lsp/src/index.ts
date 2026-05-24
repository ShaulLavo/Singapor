export { type TypeScriptLspResolvedOptions } from './plugin'
export { createTypeScriptLspPlugin } from './pluginWithWorker'
export {
  diagnosticHighlightGroups,
  summarizeDiagnostics,
  type TypeScriptLspDiagnosticHighlightGroups,
  type TypeScriptLspDiagnosticSeverity,
} from './diagnostics'
export {
  documentUriToFileName,
  fileNameToDocumentUri,
  isTypeScriptFileName,
  isTypeScriptLspSourceFileName,
  pathOrUriToDocumentUri,
  sourcePathToFileName,
} from './paths'
export type {
  TypeScriptLspDiagnosticCounts,
  TypeScriptLspDefinitionTarget,
  TypeScriptLspDiagnosticSummary,
  TypeScriptLspNavigationKind,
  TypeScriptLspNavigationOpenMode,
  TypeScriptLspNavigationOptions,
  TypeScriptLspPlugin,
  TypeScriptLspPluginOptions,
  TypeScriptLspReferencesResult,
  TypeScriptLspSourceFile,
  TypeScriptLspStatus,
} from './types'
