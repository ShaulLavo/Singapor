import { describe, expect, it } from 'vitest'
import {
  isWholeWordRange,
  lineRangeAtOffset,
  nextWordOffset,
  normalizeTextOffsetRanges,
  previousWordOffset,
  wordRangeAtOffset,
} from '../src/textRanges'

describe('text range helpers', () => {
  it('finds line ranges at clamped offsets', () => {
    const text = 'one two\nthree'

    expect(lineRangeAtOffset(text, 5)).toEqual({ start: 0, end: 7 })
    expect(lineRangeAtOffset(text, 99)).toEqual({ start: 8, end: 13 })
  })

  it('moves by word boundaries without splitting surrogate pairs', () => {
    const text = 'alpha 😀 beta'

    expect(nextWordOffset(text, 0)).toBe(6)
    expect(nextWordOffset(text, 6)).toBe(9)
    expect(previousWordOffset(text, text.length)).toBe(9)
  })

  it('expands word ranges around unicode letters and word-end offsets', () => {
    const text = 'café 😀 beta_2'

    expect(wordRangeAtOffset(text, 4)).toEqual({ start: 0, end: 4 })
    expect(wordRangeAtOffset(text, 6)).toEqual({ start: 6, end: 6 })
    expect(wordRangeAtOffset(text, text.length)).toEqual({ start: 8, end: 14 })
  })

  it('checks whole-word ranges with shared word classification', () => {
    expect(isWholeWordRange('foo food', { start: 0, end: 3 })).toBe(true)
    expect(isWholeWordRange('foo food', { start: 4, end: 7 })).toBe(false)
    expect(isWholeWordRange('café!', { start: 0, end: 4 })).toBe(true)
  })

  it('clamps and orders text ranges', () => {
    expect(
      normalizeTextOffsetRanges('abcd', [
        { start: 3, end: 9 },
        { start: -2, end: 1 },
        { start: 3, end: 2 },
      ]),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ])
  })
})
