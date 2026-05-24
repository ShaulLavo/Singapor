import { clamp } from '../style-utils'

export function lineRangeAtOffset(text: string, rawOffset: number): { start: number; end: number } {
  const offset = clamp(rawOffset, 0, text.length)
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const nextLineBreak = text.indexOf('\n', offset)
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak
  return { start: lineStart, end: lineEnd }
}

export function wordRangeAtOffset(text: string, rawOffset: number): { start: number; end: number } {
  const offset = clamp(rawOffset, 0, text.length)
  const probeOffset = wordProbeOffset(text, offset)
  if (probeOffset === null) return { start: offset, end: offset }

  let start = probeOffset
  let end = probeOffset + codePointSizeAt(text, probeOffset)

  while (start > 0) {
    const previous = previousCodePointStart(text, start)
    if (previous === null || !isWordCodePointAt(text, previous)) break
    start = previous
  }

  while (end < text.length && isWordCodePointAt(text, end)) end += codePointSizeAt(text, end)

  return { start, end }
}

function wordProbeOffset(text: string, offset: number): number | null {
  if (offset < text.length && isWordCodePointAt(text, offset)) return offset

  const previous = previousCodePointStart(text, offset)
  if (previous !== null && isWordCodePointAt(text, previous)) return previous

  return null
}

function isWordCodePointAt(text: string, offset: number): boolean {
  const codePoint = text.codePointAt(offset)
  if (codePoint === undefined) return false
  return /^[\p{L}\p{N}_]$/u.test(String.fromCodePoint(codePoint))
}

function previousCodePointStart(text: string, offset: number): number | null {
  if (offset <= 0) return null

  const previous = offset - 1
  const codeUnit = text.charCodeAt(previous)
  const beforePrevious = previous - 1
  const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff
  if (!isLowSurrogate || beforePrevious < 0) return previous

  const previousCodeUnit = text.charCodeAt(beforePrevious)
  const isHighSurrogate = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff
  return isHighSurrogate ? beforePrevious : previous
}

function codePointSizeAt(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset)
  if (codePoint === undefined) return 0
  return codePoint > 0xffff ? 2 : 1
}
