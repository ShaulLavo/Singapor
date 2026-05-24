import type {
  EditorHighlighterProvider,
  EditorHighlighterSessionOptions,
  EditorPlugin,
} from '../plugins'
import type { EditorSyntaxLanguageId } from '../syntax/session'
import {
  canUseShikiWorker,
  createShikiHighlighterSession,
  loadShikiTheme,
  type ShikiHighlighterSessionOptions,
} from './workerClient'

export type ShikiLanguageMap = Partial<Record<EditorSyntaxLanguageId, string>>

export type ShikiHighlighterPluginOptions = {
  readonly theme?: string | (() => string)
  readonly languages?: ShikiLanguageMap
  readonly preloadLanguages?: readonly string[]
  readonly preloadThemes?: readonly string[]
}

const DEFAULT_THEME = 'github-dark'
const SHARED_SHIKI_PROVIDER_STATE_KEY = Symbol.for('@editor/shiki/highlighter-provider-state')

type SharedShikiProviderState = {
  readonly providers: Map<string, EditorHighlighterProvider>
  readonly themeFunctionIds: WeakMap<() => string, number>
  nextThemeFunctionId: number
}

const DEFAULT_LANGUAGE_MAP: ShikiLanguageMap = {
  css: 'css',
  html: 'html',
  javascriptreact: 'jsx',
  javascript: 'javascript',
  json: 'json',
  tsx: 'tsx',
  typescriptreact: 'tsx',
  typescript: 'typescript',
}

export function createShikiHighlighterPlugin(
  options: ShikiHighlighterPluginOptions = {},
): EditorPlugin {
  const provider = sharedHighlighterProvider(options)

  return {
    name: 'shiki-highlighter',
    activate(context) {
      return context.registerHighlighter(provider)
    },
  }
}

const sharedHighlighterProvider = (
  options: ShikiHighlighterPluginOptions,
): EditorHighlighterProvider => {
  const cache = sharedHighlighterProviderState().providers
  const key = highlighterProviderKey(options)
  const existing = cache.get(key)
  if (existing) return existing

  const provider = {
    loadTheme: () => loadConfiguredTheme(options),
    createSession: (sessionOptions) => createSession(sessionOptions, options),
  } satisfies EditorHighlighterProvider
  cache.set(key, provider)
  return provider
}

const sharedHighlighterProviderState = (): SharedShikiProviderState => {
  const state = globalThis as Record<PropertyKey, unknown>
  const existing = state[SHARED_SHIKI_PROVIDER_STATE_KEY] as SharedShikiProviderState | undefined
  if (existing) return existing

  const next = {
    providers: new Map<string, EditorHighlighterProvider>(),
    themeFunctionIds: new WeakMap<() => string, number>(),
    nextThemeFunctionId: 1,
  }
  state[SHARED_SHIKI_PROVIDER_STATE_KEY] = next
  return next
}

const createSession = (
  sessionOptions: EditorHighlighterSessionOptions,
  pluginOptions: ShikiHighlighterPluginOptions,
) => {
  if (!canUseShikiWorker()) return null

  const lang = shikiLanguageForSession(sessionOptions, pluginOptions.languages)
  if (!lang) return null

  return createShikiHighlighterSession({
    ...sessionOptions,
    lang,
    theme: shikiThemeName(pluginOptions),
    langs: preloadLanguages(lang, pluginOptions),
    themes: pluginOptions.preloadThemes,
  } satisfies ShikiHighlighterSessionOptions)
}

const loadConfiguredTheme = (options: ShikiHighlighterPluginOptions) =>
  loadShikiTheme({
    theme: shikiThemeName(options),
    themes: options.preloadThemes,
  })

const shikiThemeName = (options: ShikiHighlighterPluginOptions): string => {
  const theme = options.theme
  if (typeof theme === 'function') return theme()

  return theme ?? DEFAULT_THEME
}

const highlighterProviderKey = (options: ShikiHighlighterPluginOptions): string =>
  JSON.stringify({
    languages: sortedEntries(options.languages),
    preloadLanguages: sortedItems(options.preloadLanguages),
    preloadThemes: sortedItems(options.preloadThemes),
    theme: themeKey(options.theme),
  })

const themeKey = (theme: ShikiHighlighterPluginOptions['theme']): string => {
  if (typeof theme !== 'function') return theme ?? DEFAULT_THEME

  const state = sharedHighlighterProviderState()
  const existing = state.themeFunctionIds.get(theme)
  if (existing) return `fn:${existing}`

  const id = state.nextThemeFunctionId
  state.nextThemeFunctionId += 1
  state.themeFunctionIds.set(theme, id)
  return `fn:${id}`
}

const shikiLanguageForSession = (
  options: EditorHighlighterSessionOptions,
  languages: ShikiLanguageMap | undefined,
): string | null => {
  if (!options.languageId) return null

  const configured = languages?.[options.languageId]
  if (configured) return configured

  const extensionLang = shikiLanguageForDocumentExtension(options.documentId, options.languageId)
  return extensionLang ?? DEFAULT_LANGUAGE_MAP[options.languageId] ?? null
}

const preloadLanguages = (
  lang: string,
  options: ShikiHighlighterPluginOptions,
): readonly string[] => [lang, ...Array.from(options.preloadLanguages ?? [])]

const sortedEntries = (
  values: ShikiLanguageMap | undefined,
): readonly (readonly [string, string])[] =>
  Object.entries(values ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))

const sortedItems = (items: readonly string[] | undefined): readonly string[] =>
  (items ?? []).toSorted()

const shikiLanguageForDocumentExtension = (
  documentId: string,
  languageId: EditorSyntaxLanguageId,
): string | null => {
  const extension = extensionForDocumentId(documentId)
  if (languageId === 'typescript' && extension === '.tsx') return 'tsx'
  if (languageId === 'javascript' && extension === '.jsx') return 'jsx'
  return null
}

const extensionForDocumentId = (documentId: string): string | null => {
  const path = documentId.split(/[?#]/, 1)[0] ?? documentId
  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dotIndex = path.lastIndexOf('.')
  if (dotIndex <= slashIndex) return null
  return path.slice(dotIndex).toLowerCase()
}
