import type {
  EditorHighlighterProvider,
  EditorHighlighterSessionOptions,
  EditorPlugin,
} from '../plugins'
import type { EditorSyntaxLanguageId } from '../syntax/session'
import {
  createShikiWorkerOwner,
  type ShikiHighlighterSessionOptions,
  type ShikiWorkerOwner,
} from './workerClient'

export type ShikiLanguageMap = Partial<Record<EditorSyntaxLanguageId, string>>

export type ShikiHighlighterPluginOptions = {
  readonly theme?: string | (() => string)
  readonly languages?: ShikiLanguageMap
  readonly preloadLanguages?: readonly string[]
  readonly preloadThemes?: readonly string[]
}

const DEFAULT_THEME = 'github-dark'

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
  return {
    name: 'shiki-highlighter',
    activate(context) {
      const owner = createShikiWorkerOwner()
      const provider = createHighlighterProvider(options, owner)

      return [
        context.registerHighlighter(provider),
        {
          dispose: () => {
            void owner.dispose().catch(() => undefined)
          },
        },
      ]
    },
  }
}

const createHighlighterProvider = (
  options: ShikiHighlighterPluginOptions,
  owner: ShikiWorkerOwner,
): EditorHighlighterProvider => {
  return {
    loadTheme: () => loadConfiguredTheme(options, owner),
    createSession: (sessionOptions) => createSession(sessionOptions, options, owner),
  }
}

const createSession = (
  sessionOptions: EditorHighlighterSessionOptions,
  pluginOptions: ShikiHighlighterPluginOptions,
  owner: ShikiWorkerOwner,
) => {
  if (!owner.canUseWorker()) return null

  const lang = shikiLanguageForSession(sessionOptions, pluginOptions.languages)
  if (!lang) return null

  return owner.createSession({
    ...sessionOptions,
    lang,
    theme: shikiThemeName(pluginOptions),
    langs: preloadLanguages(lang, pluginOptions),
    themes: pluginOptions.preloadThemes,
  } satisfies ShikiHighlighterSessionOptions)
}

const loadConfiguredTheme = (options: ShikiHighlighterPluginOptions, owner: ShikiWorkerOwner) =>
  owner.loadTheme({
    theme: shikiThemeName(options),
    themes: options.preloadThemes,
  })

const shikiThemeName = (options: ShikiHighlighterPluginOptions): string => {
  const theme = options.theme
  if (typeof theme === 'function') return theme()

  return theme ?? DEFAULT_THEME
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
