import type { EditorToken, EditorTokenStyle } from '../tokens'

import type { IncrementalTokenizerSnapshot, TokenLineSnapshot } from './tokenizer'

const FONT_STYLE_ITALIC = 1
const FONT_STYLE_BOLD = 2
const FONT_STYLE_UNDERLINE = 4
const FONT_STYLE_STRIKETHROUGH = 8

function toEditorTokenStyle(token: {
  bgColor?: string
  color?: string
  fontStyle?: number
}): EditorTokenStyle | null {
  const style: EditorTokenStyle = {}
  const fontStyle = token.fontStyle ?? 0

  if (token.color) style.color = token.color

  if (token.bgColor) style.backgroundColor = token.bgColor

  if (fontStyle & FONT_STYLE_ITALIC) style.fontStyle = 'italic'

  if (fontStyle & FONT_STYLE_BOLD) style.fontWeight = 700

  const textDecorations: string[] = []
  if (fontStyle & FONT_STYLE_UNDERLINE) textDecorations.push('underline')
  if (fontStyle & FONT_STYLE_STRIKETHROUGH) textDecorations.push('line-through')
  if (textDecorations.length > 0) style.textDecoration = textDecorations.join(' ')

  return Object.keys(style).length > 0 ? style : null
}

export function tokenLinesToEditorTokens(lines: readonly TokenLineSnapshot[]): EditorToken[] {
  const tokens: EditorToken[] = []
  let lineStart = 0

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    if (!line) continue

    for (const token of line.tokens) {
      const style = toEditorTokenStyle(token)
      if (!style) continue

      const start = lineStart + token.offset
      const end = start + token.content.length
      if (start === end) continue

      tokens.push({ end, start, style })
    }

    lineStart += line.text.length
    if (lineIndex < lines.length - 1) lineStart += 1
  }

  return tokens
}

export function snapshotToEditorTokens(
  snapshot: Pick<IncrementalTokenizerSnapshot, 'lines'>,
): EditorToken[] {
  return tokenLinesToEditorTokens(snapshot.lines)
}
