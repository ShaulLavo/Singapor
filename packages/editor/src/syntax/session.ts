import type { DocumentSessionChange } from '../documentSession'
import type { DocumentTextSnapshot } from '../documentTextSnapshot'
import type { PieceTableSnapshot } from '../pieceTable/pieceTableTypes'
import type { EditorToken, TextEdit } from '../tokens'

export type EditorSyntaxLanguageId = string

export type EditorSyntaxCapture = {
  readonly startIndex: number
  readonly endIndex: number
  readonly captureName: string
  readonly languageId?: EditorSyntaxLanguageId
}

export type FoldRange = {
  readonly startIndex: number
  readonly endIndex: number
  readonly startLine: number
  readonly endLine: number
  readonly type: string
  readonly languageId?: EditorSyntaxLanguageId
}

export type BracketInfo = {
  readonly index: number
  readonly char: string
  readonly depth: number
}

export type EditorSyntaxError = {
  readonly startIndex: number
  readonly endIndex: number
  readonly message: string
  readonly isMissing: boolean
}

export type EditorSyntaxInjection = {
  readonly parentLanguageId: EditorSyntaxLanguageId
  readonly languageId: EditorSyntaxLanguageId
  readonly startIndex: number
  readonly endIndex: number
}

export type EditorSyntaxRange = {
  readonly startIndex: number
  readonly endIndex: number
}

export type EditorSyntaxSnapshotTag = {
  readonly documentId: string | null
  readonly length: number | null
  readonly version: number
}

export type EditorSyntaxMode = 'full' | 'range' | 'none'

export type EditorSyntaxLanguageConfiguration = {
  readonly includeCaptures: boolean
  readonly includeHighlights: boolean
  readonly languageId: EditorSyntaxLanguageId | null
  readonly mode: EditorSyntaxMode
}

export type EditorSyntaxEditSummary = {
  readonly edits: readonly TextEdit[]
  readonly kind: DocumentSessionChange['kind']
}

export type EditorSyntaxServiceRequest = {
  readonly editSummary: EditorSyntaxEditSummary | null
  readonly language: EditorSyntaxLanguageConfiguration
  readonly requestedRanges: readonly EditorSyntaxRange[]
  readonly snapshot: PieceTableSnapshot
  readonly snapshotTag: EditorSyntaxSnapshotTag
  readonly textSnapshot?: DocumentTextSnapshot
}

export type EditorSyntaxProjectionTag = {
  readonly language: EditorSyntaxLanguageConfiguration
  readonly requestedRanges: readonly EditorSyntaxRange[]
  readonly snapshot: EditorSyntaxSnapshotTag
}

export type EditorSyntaxDegradedState =
  | {
      readonly kind: 'language-unavailable'
      readonly message?: string
    }
  | {
      readonly kind: 'provider-unavailable'
      readonly message?: string
    }
  | {
      readonly kind: 'range-unavailable'
      readonly message?: string
    }
  | {
      readonly kind: 'request-failed'
      readonly message: string
    }
  | {
      readonly kind: 'optional-phase-failed'
      readonly phase: string
      readonly message: string
    }
  | {
      readonly kind: 'injection-failed'
      readonly phase: string
      readonly message: string
    }

export type EditorSyntaxResult = {
  readonly captures: readonly EditorSyntaxCapture[]
  readonly folds: readonly FoldRange[]
  readonly brackets: readonly BracketInfo[]
  readonly errors: readonly EditorSyntaxError[]
  readonly injections: readonly EditorSyntaxInjection[]
  readonly degraded: EditorSyntaxDegradedState | null
  readonly projection: EditorSyntaxProjectionTag
  readonly tokens: readonly EditorToken[]
}

export type EditorSyntaxResultOptions = {
  readonly degraded?: EditorSyntaxDegradedState | null
  readonly language?: Partial<EditorSyntaxLanguageConfiguration>
  readonly requestedRanges?: readonly EditorSyntaxRange[]
  readonly snapshot?: Partial<EditorSyntaxSnapshotTag>
}

export type EditorSyntaxSessionOptions = {
  readonly documentId: string
  readonly languageId: EditorSyntaxLanguageId | null
  readonly includeHighlights?: boolean
  readonly includeCaptures?: boolean
  readonly syntaxMode?: 'full' | 'range'
  readonly fullText: string
  readonly textSnapshot?: DocumentTextSnapshot
  readonly snapshot: PieceTableSnapshot
}

export type EditorSyntaxSession = {
  refresh(snapshot: PieceTableSnapshot, fullText?: string): Promise<EditorSyntaxResult>
  applyChange(change: DocumentSessionChange): Promise<EditorSyntaxResult>
  canQueryRange?(): boolean
  queryRange?(range: EditorSyntaxRange): Promise<EditorSyntaxResult>
  getResult(): EditorSyntaxResult
  getTokens(): readonly EditorToken[]
  getSnapshotVersion(): number
  dispose(): void
}

export type EditorSyntaxProvider = {
  createSession(options: EditorSyntaxSessionOptions): EditorSyntaxSession | null
}

export const createEditorSyntaxSession = (): EditorSyntaxSession => createEmptySyntaxSession()

export const createEmptySyntaxSession = (): EditorSyntaxSession => ({
  refresh: async () => createEmptySyntaxResult(),
  applyChange: async () => createEmptySyntaxResult(),
  getResult: () => createEmptySyntaxResult(),
  getTokens: () => [],
  getSnapshotVersion: () => 0,
  dispose: () => undefined,
})

export const createSyntaxSnapshotTag = (
  snapshot: Partial<EditorSyntaxSnapshotTag> = {},
): EditorSyntaxSnapshotTag => ({
  documentId: snapshot.documentId ?? null,
  length: snapshot.length ?? null,
  version: snapshot.version ?? 0,
})

export const createSyntaxLanguageConfiguration = (
  language: Partial<EditorSyntaxLanguageConfiguration> = {},
): EditorSyntaxLanguageConfiguration => ({
  includeCaptures: language.includeCaptures ?? false,
  includeHighlights: language.includeHighlights ?? false,
  languageId: language.languageId ?? null,
  mode: language.mode ?? 'none',
})

export const createSyntaxProjectionTag = (
  options: EditorSyntaxResultOptions = {},
): EditorSyntaxProjectionTag => ({
  language: createSyntaxLanguageConfiguration(options.language),
  requestedRanges: options.requestedRanges ?? [],
  snapshot: createSyntaxSnapshotTag(options.snapshot),
})

export const createEmptySyntaxResult = (
  options: EditorSyntaxResultOptions = {},
): EditorSyntaxResult => ({
  captures: [],
  degraded: options.degraded ?? null,
  folds: [],
  brackets: [],
  errors: [],
  injections: [],
  projection: createSyntaxProjectionTag(options),
  tokens: [],
})

export const isEditorSyntaxLanguage = (
  languageId: string | null | undefined,
): languageId is EditorSyntaxLanguageId => {
  if (!languageId) return false
  return languageId.trim().length > 0
}
