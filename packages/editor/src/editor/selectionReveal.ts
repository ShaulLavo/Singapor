export type EditorSelectionRevealOptions = {
  readonly reveal?: boolean
  readonly revealOffset?: number
}

export type EditorSelectionRevealTarget = number | EditorSelectionRevealOptions

export function selectionRevealOffset(
  reveal: EditorSelectionRevealTarget | undefined,
  fallback: number | undefined,
): number | undefined {
  if (typeof reveal === 'number') return reveal
  if (reveal?.reveal === false) return undefined

  return reveal?.revealOffset ?? fallback
}
