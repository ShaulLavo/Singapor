import { describe, expect, it } from 'vitest'

import { createTextDiffEdit } from '../../src/shiki/workerClient'

describe('ShikiHighlighterSession edit diffing', () => {
  it('builds a cumulative edit from cached text to latest text', () => {
    expect(createTextDiffEdit('const a = 1;', 'const a = 1;!?')).toEqual({
      from: 12,
      to: 12,
      text: '!?',
    })
  })

  it('builds replacement edits without requiring the skipped UI edit', () => {
    expect(createTextDiffEdit('const value = 1;', 'const answer = 1;')).toEqual({
      from: 6,
      to: 11,
      text: 'answer',
    })
  })
})
