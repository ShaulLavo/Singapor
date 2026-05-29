import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createPieceTableSnapshot } from '../../src'
import type { EditorHighlighterProvider, EditorPluginContext } from '../../src/plugins'
import { createShikiHighlighterPlugin } from '../../src/shiki'

const workerOwner = vi.hoisted(() => ({
  canUseWorker: vi.fn(() => true),
  createSession: vi.fn(() => null),
  dispose: vi.fn(async () => undefined),
  loadTheme: vi.fn(),
}))
const createShikiWorkerOwner = vi.hoisted(() => vi.fn(() => workerOwner))

vi.mock('../../src/shiki/workerClient', () => ({
  createShikiWorkerOwner,
}))

describe('createShikiHighlighterPlugin', () => {
  beforeEach(() => {
    createShikiWorkerOwner.mockClear()
    workerOwner.canUseWorker.mockClear()
    workerOwner.canUseWorker.mockReturnValue(true)
    workerOwner.createSession.mockClear()
    workerOwner.dispose.mockClear()
    workerOwner.loadTheme.mockClear()
  })

  it('maps .tsx TypeScript documents to Shiki TSX', () => {
    const provider = activateHighlighterProvider()
    const text = 'const el = <div className="x" />'

    provider.createSession({
      documentId: 'App.tsx',
      languageId: 'typescript',
      text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(workerOwner.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: 'tsx',
      }),
    )
  })

  it('maps .jsx JavaScript documents to Shiki JSX', () => {
    const provider = activateHighlighterProvider()
    const text = 'const el = <div className="x" />'

    provider.createSession({
      documentId: 'App.jsx',
      languageId: 'javascript',
      text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(workerOwner.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: 'jsx',
      }),
    )
  })

  it('keeps explicit language overrides ahead of extension inference', () => {
    const provider = activateHighlighterProvider({ languages: { typescript: 'typescript' } })
    const text = 'const el = <div className="x" />'

    provider.createSession({
      documentId: 'App.tsx',
      languageId: 'typescript',
      text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(workerOwner.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: 'typescript',
      }),
    )
  })

  it('creates an explicit worker owner for each activation', () => {
    const first = activateHighlighterProvider({
      preloadLanguages: ['typescript', 'tsx'],
      preloadThemes: ['github-dark'],
    })
    const second = activateHighlighterProvider({
      preloadLanguages: ['tsx', 'typescript'],
      preloadThemes: ['github-dark'],
    })

    expect(createShikiWorkerOwner).toHaveBeenCalledTimes(2)
    expect(second).not.toBe(first)
  })
})

function activateHighlighterProvider(
  options: Parameters<typeof createShikiHighlighterPlugin>[0] = {},
): EditorHighlighterProvider {
  let provider: EditorHighlighterProvider | null = null
  const context = {
    registerHighlighter: (nextProvider) => {
      provider = nextProvider
      return { dispose: () => undefined }
    },
  } satisfies Partial<EditorPluginContext>

  createShikiHighlighterPlugin(options).activate(context as EditorPluginContext)
  if (!provider) throw new Error('Expected Shiki plugin to register a highlighter')
  return provider
}
