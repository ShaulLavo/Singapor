import { describe, expect, it } from 'vitest'

import {
  appendChunksToBuffers,
  bufferForPiece,
  countLineBreaks,
  createInitialBuffers,
  createOriginalPiece,
  createPiece,
  getBufferText,
} from '../src/pieceTable/buffers.ts'

describe('piece table buffers', () => {
  it('counts line breaks inside an optional range', () => {
    expect(countLineBreaks('a\nb\nc')).toBe(2)
    expect(countLineBreaks('a\nb\nc', 2, 4)).toBe(1)
    expect(countLineBreaks('a\nb\nc', 4, 5)).toBe(0)
  })

  it('creates original pieces with line-break metadata', () => {
    const buffers = createInitialBuffers('alpha\nbeta')
    const piece = createOriginalPiece(buffers)

    expect(getBufferText(buffers, buffers.original)).toBe('alpha\nbeta')
    expect(piece).toMatchObject({
      buffer: buffers.original,
      start: 0,
      length: 10,
      lineBreaks: 1,
      visible: true,
    })
  })

  it('creates sliced pieces and reads their backing buffer', () => {
    const buffers = createInitialBuffers('alpha\nbeta')
    const piece = createPiece(buffers, buffers.original, 6, 4, 20, false)

    expect(piece).toMatchObject({ start: 6, length: 4, lineBreaks: 0, visible: false })
    expect(bufferForPiece(buffers, piece)).toBe('alpha\nbeta')
  })

  it('splits appended text into bounded chunks', () => {
    const buffers = createInitialBuffers('')
    const text = 'x'.repeat(16 * 1024) + 'tail'
    const pieces = appendChunksToBuffers(buffers, text)

    expect(pieces).toHaveLength(2)
    expect(pieces.map((piece) => piece.length)).toEqual([16 * 1024, 4])
    expect(pieces.map((piece) => getBufferText(buffers, piece.buffer))).toEqual([
      'x'.repeat(16 * 1024),
      'tail',
    ])
  })
})
