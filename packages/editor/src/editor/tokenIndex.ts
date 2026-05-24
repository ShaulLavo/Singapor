import type { EditorToken } from '../tokens'

export type EditorTokenIndex = {
  readonly maxEnds: readonly number[]
  readonly monotonicEnd: boolean
  readonly nonOverlapping: boolean
  readonly sortedByStart: boolean
}

export type EditorTokenIndexBuilder = {
  readonly maxEnds: number[]
  maxEnd: number
  monotonicEnd: boolean
  nonOverlapping: boolean
  previousEnd: number
  previousStart: number
  sortedByStart: boolean
}

const tokenIndexes = new WeakMap<readonly EditorToken[], EditorTokenIndex>()

export function getEditorTokenIndex(tokens: readonly EditorToken[]): EditorTokenIndex | null {
  return tokenIndexes.get(tokens) ?? null
}

export function copyEditorTokenIndex(
  sourceTokens: readonly EditorToken[],
  copiedTokens: readonly EditorToken[],
): void {
  const index = tokenIndexes.get(sourceTokens)
  if (index) tokenIndexes.set(copiedTokens, index)
}

export function createEditorTokenIndexBuilder(): EditorTokenIndexBuilder {
  return {
    maxEnd: 0,
    maxEnds: [],
    monotonicEnd: true,
    nonOverlapping: true,
    previousEnd: -Infinity,
    previousStart: -Infinity,
    sortedByStart: true,
  }
}

export function appendEditorTokenIndexEntry(
  builder: EditorTokenIndexBuilder,
  token: EditorToken,
): void {
  if (token.start < builder.previousStart) builder.sortedByStart = false
  if (token.start < builder.previousEnd) builder.nonOverlapping = false
  if (token.end < builder.maxEnd) builder.monotonicEnd = false

  builder.maxEnd = Math.max(builder.maxEnd, token.end)
  builder.maxEnds.push(builder.maxEnd)
  builder.previousEnd = token.end
  builder.previousStart = token.start
}

export function setEditorTokenIndex(tokens: readonly EditorToken[], index: EditorTokenIndex): void {
  tokenIndexes.set(tokens, index)
}

export function finishEditorTokenIndex(
  tokens: readonly EditorToken[],
  builder: EditorTokenIndexBuilder,
): void {
  setEditorTokenIndex(tokens, {
    maxEnds: builder.maxEnds,
    monotonicEnd: builder.monotonicEnd,
    nonOverlapping: builder.nonOverlapping,
    sortedByStart: builder.sortedByStart,
  })
}
