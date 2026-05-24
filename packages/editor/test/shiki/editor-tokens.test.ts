import { afterEach, describe, expect, it } from 'vitest'

import {
  createIncrementalTokenizer,
  snapshotToEditorTokens,
  tokenLinesToEditorTokens,
} from '../../src/shiki'

describe('editor token adapters', () => {
  it('converts line-local token offsets into document offsets', () => {
    const tokens = tokenLinesToEditorTokens([
      {
        text: 'const answer = 42',
        tokens: [
          { color: '#f00', content: 'const', fontStyle: 0, offset: 0 },
          { color: '#0f0', content: 'answer', fontStyle: 0, offset: 6 },
        ],
      },
      {
        text: 'return answer',
        tokens: [{ color: '#00f', content: 'return', fontStyle: 0, offset: 0 }],
      },
    ])

    expect(tokens).toEqual([
      { end: 5, start: 0, style: { color: '#f00' } },
      { end: 12, start: 6, style: { color: '#0f0' } },
      { end: 24, start: 18, style: { color: '#00f' } },
    ])
  })

  it('maps Shiki font styles into editor styles', () => {
    const tokens = snapshotToEditorTokens({
      lines: [
        {
          text: 'value',
          tokens: [
            {
              color: '#fff',
              content: 'value',
              fontStyle: 1 | 2 | 4 | 8,
              offset: 0,
            },
          ],
        },
      ],
    })

    expect(tokens).toEqual([
      {
        end: 5,
        start: 0,
        style: {
          color: '#fff',
          fontStyle: 'italic',
          fontWeight: 700,
          textDecoration: 'underline line-through',
        },
      },
    ])
  })
})

describe('shiki-to-editor integration', () => {
  const highlighters: Array<{ dispose: () => void }> = []

  afterEach(() => {
    while (highlighters.length > 0) highlighters.pop()?.dispose()
  })

  it('tokenizes code through Shiki and produces valid EditorToken offsets', async () => {
    const code = 'const x = 1;\nconst y = 2;'
    const { tokenizer, highlighter } = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code,
    })
    highlighters.push(highlighter)

    const tokens = snapshotToEditorTokens(tokenizer.getSnapshot())

    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) {
      expect(token.start).toBeGreaterThanOrEqual(0)
      expect(token.end).toBeLessThanOrEqual(code.length)
      expect(token.end).toBeGreaterThan(token.start)
      expect(token.style).toBeDefined()
      expect(Object.keys(token.style).length).toBeGreaterThan(0)
    }
  })
})
