import {
  blockLaneCoversBufferRow,
  isDocumentTextDisplayRow,
  normalizeBlockLanes,
  visualColumnLength,
  type BlockLane,
  type BlockLanePlacement,
  type DisplayTextRow,
} from '../displayTransforms'
import { setStyleValue } from './virtualizedTextViewHelpers'
import { rowHeight, rowTop } from './virtualizedTextViewLayout'
import type {
  MountedVirtualizedBlockLane,
  VirtualizedTextViewInternal,
} from './virtualizedTextViewInternals'
import type { FixedRowVirtualizerSnapshot } from './fixedRowVirtualizer'
import type { MountedVirtualizedTextRow } from './virtualizedTextViewTypes'

type BlockLaneInset = {
  readonly left: number
  readonly right: number
  readonly key: string
}

type VisibleBlockLaneLayout = {
  readonly lane: BlockLane
  readonly top: number
  readonly height: number
  readonly left: number
  readonly width: number
  readonly measuredWidth: boolean
  readonly key: string
}

export function setBlockLanesLayout(
  view: VirtualizedTextViewInternal,
  blockLanes: readonly BlockLane[],
): void {
  view.blockLanes = normalizeBlockLanes(blockLanes)
}

export function rowBlockLaneInset(
  view: VirtualizedTextViewInternal,
  rowIndex: number,
): BlockLaneInset {
  const displayRow = textDisplayRowForIndex(view, rowIndex)
  if (!displayRow) return { left: 0, right: 0, key: '' }

  const left = blockLaneWidthForBufferRow(view.blockLanes, displayRow.bufferRow, 'left')
  const right = blockLaneWidthForBufferRow(view.blockLanes, displayRow.bufferRow, 'right')
  const key = blockLaneKeyForBufferRow(view.blockLanes, displayRow.bufferRow)
  return { left, right, key }
}

export function applyRowBlockLaneInset(
  row: MountedVirtualizedTextRow,
  inset: BlockLaneInset,
): void {
  setRowPadding(row.element, 'paddingLeft', inset.left)
  setRowPadding(row.element, 'paddingRight', inset.right)
  setRowBlockLaneState(row, inset)
}

export function renderBlockLanes(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): void {
  if (!view.blockLaneMount || view.blockLanes.length === 0) {
    disposeAllMountedBlockLanes(view)
    return
  }

  const layouts = visibleBlockLaneLayouts(view, snapshot)
  const nextIds = new Set(layouts.map((layout) => layout.lane.id))
  disposeStaleMountedBlockLanes(view, nextIds)
  for (const layout of layouts) mountOrUpdateBlockLane(view, layout)
}

export function disposeAllMountedBlockLanes(view: VirtualizedTextViewInternal): void {
  for (const mounted of view.blockLaneElements.values()) disposeMountedBlockLane(mounted)
  view.blockLaneElements.clear()
}

export function rowTextInsetLeft(row: MountedVirtualizedTextRow): number {
  return row.leftBlockLaneWidth
}

export function rowTextInsetRight(row: MountedVirtualizedTextRow): number {
  return row.rightBlockLaneWidth
}

export function estimatedDisplayRowWidthPx(
  view: VirtualizedTextViewInternal,
  rowIndex: number,
): number {
  const text = textDisplayRowForIndex(view, rowIndex)?.text ?? ''
  const textWidth = estimatedTextWidthPx(view, text)
  const inset = rowBlockLaneInset(view, rowIndex)
  return inset.left + textWidth + inset.right
}

function blockLaneWidthForBufferRow(
  lanes: readonly BlockLane[],
  bufferRow: number,
  placement: BlockLanePlacement,
): number {
  let width = 0
  for (const lane of lanes) {
    if (lane.placement !== placement) continue
    if (!blockLaneCoversBufferRow(lane, bufferRow)) continue
    width += lane.widthPx
  }

  return width
}

function blockLaneKeyForBufferRow(lanes: readonly BlockLane[], bufferRow: number): string {
  const parts: string[] = []
  for (const lane of lanes) {
    if (!blockLaneCoversBufferRow(lane, bufferRow)) continue
    parts.push(`${lane.placement}:${lane.id}:${lane.widthPx}`)
  }

  return parts.join('|')
}

function textDisplayRowForIndex(
  view: VirtualizedTextViewInternal,
  rowIndex: number,
): DisplayTextRow | null {
  const displayRow = view.displayRows[rowIndex]
  if (!isDocumentTextDisplayRow(displayRow)) return null
  return displayRow
}

function setRowPadding(
  element: HTMLElement,
  property: 'paddingLeft' | 'paddingRight',
  width: number,
): void {
  const value = width > 0 ? `${width}px` : ''
  if (element.style[property] === value) return
  element.style[property] = value
}

function setRowBlockLaneState(row: MountedVirtualizedTextRow, inset: BlockLaneInset): void {
  const mutable = row as {
    leftBlockLaneWidth: number
    rightBlockLaneWidth: number
    blockLaneKey: string
  }
  mutable.leftBlockLaneWidth = inset.left
  mutable.rightBlockLaneWidth = inset.right
  mutable.blockLaneKey = inset.key
}

function visibleBlockLaneLayouts(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): readonly VisibleBlockLaneLayout[] {
  const layouts: VisibleBlockLaneLayout[] = []
  for (const lane of view.blockLanes) {
    const layout = visibleBlockLaneLayout(view, snapshot, lane)
    if (!layout) continue
    layouts.push(layout)
  }

  return layouts
}

function visibleBlockLaneLayout(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
  lane: BlockLane,
): VisibleBlockLaneLayout | null {
  const range = visibleLaneDisplayRange(view, snapshot, lane)
  if (!range) return null

  const top = rowTop(view, range.start)
  const bottom = rowTop(view, range.end) + rowHeight(view, range.end)
  return {
    lane,
    top,
    height: Math.max(0, bottom - top),
    left: blockLaneLeft(view, lane, range.start, range.end),
    width: lane.widthPx,
    measuredWidth: lane.widthMeasured === true,
    key: `${lane.id}:${top}:${bottom}:${lane.widthPx}:${lane.widthMeasured === true}`,
  }
}

function visibleLaneDisplayRange(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
  lane: BlockLane,
): { readonly start: number; readonly end: number } | null {
  let start = Number.POSITIVE_INFINITY
  let end = -1
  for (const item of snapshot.virtualItems) {
    const displayRow = textDisplayRowForIndex(view, item.index)
    if (!displayRow) continue
    if (!blockLaneCoversBufferRow(lane, displayRow.bufferRow)) continue
    start = Math.min(start, item.index)
    end = Math.max(end, item.index)
  }

  if (end === -1) return null
  return { start, end }
}

function blockLaneLeft(
  view: VirtualizedTextViewInternal,
  lane: BlockLane,
  startRow: number,
  endRow: number,
): number {
  if (lane.placement === 'left') {
    return gutterWidth(view) + precedingLaneWidth(view.blockLanes, lane, 'left')
  }

  return (
    gutterWidth(view) +
    maxLeftLaneWidth(view, startRow, endRow) +
    maxTextWidth(view, startRow, endRow) +
    precedingLaneWidth(view.blockLanes, lane, 'right')
  )
}

function precedingLaneWidth(
  lanes: readonly BlockLane[],
  target: BlockLane,
  placement: BlockLanePlacement,
): number {
  let width = 0
  for (const lane of lanes) {
    if (lane === target) return width
    if (lane.placement !== placement) continue
    if (!blockLanesOverlap(lane, target)) continue
    width += lane.widthPx
  }

  return width
}

function blockLanesOverlap(left: BlockLane, right: BlockLane): boolean {
  if (left.endBufferRow < right.startBufferRow) return false
  return right.endBufferRow >= left.startBufferRow
}

function maxLeftLaneWidth(
  view: VirtualizedTextViewInternal,
  startRow: number,
  endRow: number,
): number {
  let width = 0
  for (let row = startRow; row <= endRow; row += 1) {
    const displayRow = textDisplayRowForIndex(view, row)
    if (!displayRow) continue
    width = Math.max(
      width,
      blockLaneWidthForBufferRow(view.blockLanes, displayRow.bufferRow, 'left'),
    )
  }

  return width
}

function maxTextWidth(view: VirtualizedTextViewInternal, startRow: number, endRow: number): number {
  let width = 0
  for (let row = startRow; row <= endRow; row += 1) {
    const displayRow = textDisplayRowForIndex(view, row)
    if (!displayRow) continue
    width = Math.max(width, estimatedTextWidthPx(view, displayRow.text))
  }

  return width
}

function disposeStaleMountedBlockLanes(
  view: VirtualizedTextViewInternal,
  nextIds: ReadonlySet<string>,
): void {
  for (const [id, mounted] of view.blockLaneElements) {
    if (nextIds.has(id)) continue
    disposeMountedBlockLane(mounted)
    view.blockLaneElements.delete(id)
  }
}

function mountOrUpdateBlockLane(
  view: VirtualizedTextViewInternal,
  layout: VisibleBlockLaneLayout,
): void {
  const mounted = view.blockLaneElements.get(layout.lane.id)
  if (mounted) {
    updateMountedBlockLane(mounted, layout)
    return
  }

  const element = view.scrollElement.ownerDocument.createElement('div')
  element.className = 'editor-virtualized-horizontal-block-surface'
  element.dataset.editorBlockSurface = layout.lane.placement
  const disposable = view.blockLaneMount?.(element, {
    id: layout.lane.id,
    placement: layout.lane.placement,
    startBufferRow: layout.lane.startBufferRow,
    endBufferRow: layout.lane.endBufferRow,
  })
  const nextMounted = {
    id: layout.lane.id,
    element,
    mountDisposable: disposable ?? null,
    layoutKey: '',
  }
  view.blockLaneElements.set(layout.lane.id, nextMounted)
  view.blockLaneLayerElement.appendChild(element)
  updateMountedBlockLane(nextMounted, layout)
}

function updateMountedBlockLane(
  mounted: MountedVirtualizedBlockLane,
  layout: VisibleBlockLaneLayout,
): void {
  if (mounted.layoutKey === layout.key) return

  setStyleValue(mounted.element, 'transform', `translate(${layout.left}px, ${layout.top}px)`)
  setStyleValue(mounted.element, 'width', layout.measuredWidth ? '' : `${layout.width}px`)
  setStyleValue(mounted.element, 'height', `${layout.height}px`)
  setMountedBlockLaneLayoutKey(mounted, layout.key)
}

function disposeMountedBlockLane(mounted: MountedVirtualizedBlockLane): void {
  scheduleMountedBlockLaneDisposal(mounted)
}

function scheduleMountedBlockLaneDisposal(mounted: MountedVirtualizedBlockLane): void {
  const dispose = () => {
    mounted.mountDisposable?.dispose()
    mounted.element.remove()
  }
  const window = mounted.element.ownerDocument.defaultView

  // React-backed block surfaces may be disposed while the host React tree is
  // committing. Run both the provider cleanup and DOM removal after that commit.
  if (window?.queueMicrotask) {
    window.queueMicrotask(dispose)
    return
  }

  if (globalThis.queueMicrotask) {
    globalThis.queueMicrotask(dispose)
    return
  }

  if (window?.setTimeout) {
    window.setTimeout(dispose, 0)
    return
  }

  globalThis.setTimeout(dispose, 0)
}

function setMountedBlockLaneLayoutKey(
  mounted: MountedVirtualizedBlockLane,
  layoutKey: string,
): void {
  const mutable = mounted as { layoutKey: string }
  mutable.layoutKey = layoutKey
}

function characterWidth(view: VirtualizedTextViewInternal): number {
  return Math.max(1, view.metrics.characterWidth)
}

function gutterWidth(view: VirtualizedTextViewInternal): number {
  return view.currentGutterWidth
}

function estimatedTextWidthPx(view: VirtualizedTextViewInternal, text: string): number {
  return visualColumnLength(text, view.tabSize) * characterWidth(view)
}
