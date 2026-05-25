import { setStyleValue } from './virtualizedTextViewHelpers'
import { rangeSegments } from './virtualizedTextViewGeometry'
import { rowTextInsetLeft } from './virtualizedTextViewBlockLanes'
import type {
  VirtualizedStoredSelection,
  VirtualizedTextViewInternal,
} from './virtualizedTextViewInternals'
import type { MountedVirtualizedTextRow } from './virtualizedTextViewTypes'

type SelectionSegment = {
  readonly start: number
  readonly end: number
  readonly left: number
  readonly width: number
}

export function renderSelectionLayer(view: VirtualizedTextViewInternal): void {
  for (const row of view.rowElements.values()) {
    renderSelectionLayerForRow(view, row)
  }
}

export function clearSelectionLayer(view: VirtualizedTextViewInternal): void {
  for (const row of view.rowElements.values()) {
    clearSelectionLayerForRow(row)
  }
}

function renderSelectionLayerForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): void {
  const segments = selectionSegmentsForRow(view, row)
  if (segments.length === 0) {
    clearSelectionLayerForRow(row)
    return
  }

  const key = selectionSegmentKey(segments)
  if (row.selectionLayerKey === key) {
    attachSelectionLayer(row)
    return
  }

  setSelectionLayerKey(row, key)
  row.selectionLayerElement.replaceChildren(
    ...segments.map((segment) => createSelectionElement(row, segment)),
  )
  attachSelectionLayer(row)
}

function selectionSegmentsForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): readonly SelectionSegment[] {
  if (row.kind !== 'text') return []

  const segments: SelectionSegment[] = []
  for (const selection of view.selections)
    appendSelectionSegmentForRange(segments, view, row, selection)

  return mergeSelectionSegments(segments)
}

function appendSelectionSegmentForRange(
  segments: SelectionSegment[],
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  selection: VirtualizedStoredSelection,
): void {
  const emptyRowSegment = emptyRowSelectionSegment(view, row, selection)
  if (emptyRowSegment) {
    segments.push(emptyRowSegment)
    return
  }

  segments.push(...rangeSegments(view, row, selection.start, selection.end))
}

function emptyRowSelectionSegment(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  selection: VirtualizedStoredSelection,
): SelectionSegment | null {
  const offset = emptyRowSelectionOffset(view, row)
  if (offset === null) return null
  if (!selectionIncludesOffset(selection, offset)) return null

  return {
    start: row.startOffset,
    end: row.endOffset,
    left: rowTextInsetLeft(row),
    width: Math.max(1, view.metrics.characterWidth),
  }
}

function emptyRowSelectionOffset(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): number | null {
  if (row.text.length !== 0) return null
  if (row.startOffset < view.textLength) return row.startOffset
  if (row.startOffset === 0) return null
  if (view.textSnapshot.readRange(row.startOffset - 1, row.startOffset) !== '\n') return null
  return row.startOffset - 1
}

function selectionIncludesOffset(selection: VirtualizedStoredSelection, offset: number): boolean {
  return selection.start <= offset && offset < selection.end
}

function mergeSelectionSegments(
  segments: readonly SelectionSegment[],
): readonly SelectionSegment[] {
  const sorted = segments.toSorted((left, right) => left.start - right.start)
  const merged: SelectionSegment[] = []
  for (const segment of sorted) mergeSelectionSegment(merged, segment)
  return merged
}

function mergeSelectionSegment(segments: SelectionSegment[], segment: SelectionSegment): void {
  const previous = segments.at(-1)
  if (!previous || previous.end < segment.start) {
    segments.push(segment)
    return
  }

  segments[segments.length - 1] = {
    start: previous.start,
    end: Math.max(previous.end, segment.end),
    left: Math.min(previous.left, segment.left),
    width:
      Math.max(previous.left + previous.width, segment.left + segment.width) -
      Math.min(previous.left, segment.left),
  }
}

function selectionSegmentKey(segments: readonly SelectionSegment[]): string {
  return segments.map(selectionSegmentKeyPart).join('|')
}

function selectionSegmentKeyPart(segment: SelectionSegment): string {
  return `${segment.start}:${segment.end}:${segment.left}:${segment.width}`
}

function createSelectionElement(
  row: MountedVirtualizedTextRow,
  segment: SelectionSegment,
): HTMLSpanElement {
  const element = row.element.ownerDocument.createElement('span')
  element.className = 'editor-virtualized-selection-range'
  element.dataset.editorSelectionStart = String(segment.start)
  element.dataset.editorSelectionEnd = String(segment.end)
  setStyleValue(element, 'left', `${segment.left}px`)
  setStyleValue(element, 'width', `${segment.width}px`)
  return element
}

function clearSelectionLayerForRow(row: MountedVirtualizedTextRow): void {
  setSelectionLayerKey(row, '')
  row.selectionLayerElement.replaceChildren()
  row.selectionLayerElement.remove()
}

function attachSelectionLayer(row: MountedVirtualizedTextRow): void {
  const layer = row.selectionLayerElement
  if (layer.parentElement === row.element) return

  row.element.insertBefore(layer, row.element.firstChild)
}

function setSelectionLayerKey(row: MountedVirtualizedTextRow, key: string): void {
  const mutable = row as { selectionLayerKey: string }
  mutable.selectionLayerKey = key
}
