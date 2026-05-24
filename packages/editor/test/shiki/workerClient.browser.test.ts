import { afterEach, describe, expect, it } from 'vitest'
import {
  createDocumentTextSnapshot,
  createPieceTableSnapshot,
  type DocumentSessionChange,
} from '../../src'

import { createShikiHighlighterSession, disposeShikiWorker, loadShikiTheme } from '../../src/shiki'

const createChange = (text: string, edit: { from: number; to: number; text: string }) =>
  ((snapshot = createPieceTableSnapshot(text)) => ({
    kind: 'edit',
    edits: [edit],
    text,
    textSnapshot: createDocumentTextSnapshot(snapshot, text),
    snapshot,
    selections: { selections: [], normalized: true },
    tokens: [],
    timings: [],
    canUndo: false,
    canRedo: false,
    isDirty: true,
  }))() satisfies DocumentSessionChange

describe.skipIf(typeof Worker === 'undefined')('Shiki worker highlighter', () => {
  afterEach(async () => {
    await disposeShikiWorker()
  })

  it('tokenizes code through the real browser Worker', async () => {
    const text = 'const value = 1;'
    const session = createShikiHighlighterSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(session).not.toBeNull()

    const result = await session!.refresh(createPieceTableSnapshot(text), text)

    expect(result.tokens.length).toBeGreaterThan(0)
    expect(result.tokens.every((token) => token.start >= 0 && token.end <= text.length)).toBe(true)
    session!.dispose()
  })

  it('loads theme colors without a highlighter session', async () => {
    const theme = await loadShikiTheme({ theme: 'github-dark' })

    expect(theme?.backgroundColor).toBeTruthy()
    expect(theme?.foregroundColor).toBeTruthy()
  })

  it('updates tokens after an incremental edit', async () => {
    const initialText = 'const a = 1;'
    const nextText = 'const answer = 1;'
    const session = createShikiHighlighterSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      text: initialText,
      snapshot: createPieceTableSnapshot(initialText),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(initialText), initialText)
    const result = await session!.applyChange(
      createChange(nextText, { from: 6, to: 7, text: 'answer' }),
    )

    expect(result.tokens.length).toBeGreaterThan(0)
    expect(result.tokens.some((token) => token.end > initialText.length)).toBe(true)
    session!.dispose()
  })

  it('diffs from cached worker text when earlier UI edits were skipped', async () => {
    const initialText = 'const a = 1;'
    const nextText = 'const answer = 1;'
    const session = createShikiHighlighterSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      text: initialText,
      snapshot: createPieceTableSnapshot(initialText),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(initialText), initialText)
    const result = await session!.applyChange(
      createChange(nextText, { from: 11, to: 11, text: 'r' }),
    )

    expect(result.tokens.some((token) => token.start === 6 && token.end === 12)).toBe(true)
    session!.dispose()
  })

  it('disposes document tokenizer state', async () => {
    const text = 'const value = 1;'
    const session = createShikiHighlighterSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(text), text)
    session!.dispose()

    const next = await session!.applyChange(
      createChange('const nextValue = 1;', { from: 6, to: 11, text: 'nextValue' }),
    )

    expect(next.tokens.length).toBeGreaterThan(0)
  })
})
