export { createIncrementalTokenizer } from './tokenizer'
export { createShikiHighlighterPlugin } from './plugin'
export {
  canUseShikiWorker,
  createShikiHighlighterSession,
  disposeShikiWorker,
  loadShikiTheme,
} from './workerClient'

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
export type { ShikiHighlighterSessionOptions, ShikiThemeOptions } from './workerClient'
