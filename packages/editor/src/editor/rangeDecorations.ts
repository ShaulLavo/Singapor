import type { EditorRangeDecoration } from './types'

type RangeDecorationGroup = {
  readonly name: string
  readonly ranges: EditorRangeDecoration[]
  readonly style: ReturnType<typeof rangeDecorationStyle>
}

type PendingRangeDecorationGroup = RangeDecorationGroup & {
  readonly key: string
}

export function groupedRangeDecorations(
  decorations: readonly EditorRangeDecoration[],
  highlightPrefix: string,
): readonly RangeDecorationGroup[] {
  const groups: PendingRangeDecorationGroup[] = []

  for (const decoration of decorations) {
    const style = rangeDecorationStyle(decoration)
    const key = rangeDecorationGroupKey(decoration.className, style)
    const previous = groups.at(-1)
    if (!previous || previous.key !== key) {
      groups.push(rangeDecorationGroup(highlightPrefix, decoration, style, key, groups.length))
      continue
    }

    previous.ranges.push(decoration)
  }

  return groups
}

export function sameEditorRangeDecorations(
  left: readonly EditorRangeDecoration[],
  right: readonly EditorRangeDecoration[],
): boolean {
  if (left.length !== right.length) return false

  return left.every((decoration, index) => {
    const next = right[index]
    return next ? sameEditorRangeDecoration(decoration, next) : false
  })
}

function rangeDecorationStyle(decoration: EditorRangeDecoration): {
  readonly backgroundColor?: string
  readonly color?: string
  readonly textDecoration?: string
} {
  return {
    backgroundColor: decoration.style?.backgroundColor || undefined,
    color: decoration.style?.color || undefined,
    textDecoration: decoration.style?.textDecoration || undefined,
  }
}

function rangeDecorationGroup(
  highlightPrefix: string,
  decoration: EditorRangeDecoration,
  style: ReturnType<typeof rangeDecorationStyle>,
  key: string,
  index: number,
): PendingRangeDecorationGroup {
  return {
    key,
    name: rangeDecorationGroupName(highlightPrefix, decoration.className, index),
    ranges: [decoration],
    style,
  }
}

function rangeDecorationGroupName(
  highlightPrefix: string,
  className: string | undefined,
  index: number,
): string {
  const semanticName = sanitizedHighlightName(className)
  if (semanticName) return `${highlightPrefix}-range-${semanticName}-${index}`
  return `${highlightPrefix}-range-decoration-${index}`
}

function rangeDecorationGroupKey(
  className: string | undefined,
  style: ReturnType<typeof rangeDecorationStyle>,
): string {
  return [
    className ?? '',
    style.backgroundColor ?? '',
    style.color ?? '',
    style.textDecoration ?? '',
  ].join('\u0000')
}

function sameEditorRangeDecoration(
  left: EditorRangeDecoration,
  right: EditorRangeDecoration,
): boolean {
  if (left.start !== right.start) return false
  if (left.end !== right.end) return false
  if (left.className !== right.className) return false

  return sameRangeDecorationStyle(left, right)
}

function sameRangeDecorationStyle(
  left: EditorRangeDecoration,
  right: EditorRangeDecoration,
): boolean {
  const leftStyle = rangeDecorationStyle(left)
  const rightStyle = rangeDecorationStyle(right)
  if (leftStyle.backgroundColor !== rightStyle.backgroundColor) return false
  if (leftStyle.color !== rightStyle.color) return false

  return leftStyle.textDecoration === rightStyle.textDecoration
}

function sanitizedHighlightName(value: string | undefined): string | null {
  const firstClassName = value?.split(/\s+/).find(Boolean)
  if (!firstClassName) return null

  const sanitized = firstClassName.replaceAll(/[^a-zA-Z0-9_-]/g, '-')
  if (sanitized.length === 0) return null
  if (/^[a-zA-Z_]/.test(sanitized)) return sanitized
  return `_${sanitized}`
}
