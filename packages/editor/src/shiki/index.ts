export { createIncrementalTokenizer } from './tokenizer'
export { createShikiHighlighterPlugin } from './plugin'
export {
  EDITOR_SHIKI_SYNTAX_SCOPE_MAPPINGS,
  editorThemeToShikiTheme,
  editorThemeToShikiTokenColors,
} from './theme'
export { canUseShikiWorker, createShikiWorkerOwner, ShikiWorkerOwner } from './workerClient'

export { snapshotToEditorTokens, tokenLinesToEditorTokens } from './editor-tokens'

export type {
  CreateIncrementalTokenizerOptions,
  CreateIncrementalTokenizerResult,
  IncrementalTokenizer,
  IncrementalTokenizerSnapshot,
  LineTokens,
  StatesEqualFn,
  TokenizeLineFn,
  TokenLineSnapshot,
  TokenPatch,
} from './tokenizer'
export type { ShikiHighlighterPluginOptions, ShikiLanguageMap } from './plugin'
export type {
  EditorShikiSyntaxScopeMapping,
  EditorShikiTheme,
  EditorShikiThemeColorMode,
  EditorShikiThemeSettingLike,
  EditorThemeToShikiThemeOptions,
} from './theme'
export type {
  ShikiHighlighterSessionOptions,
  ShikiThemeOptions,
  ShikiWorkerCacheSnapshot,
  ShikiWorkerLifecycleState,
  ShikiWorkerOwnerOptions,
  ShikiWorkerOwnerSnapshot,
} from './workerClient'
