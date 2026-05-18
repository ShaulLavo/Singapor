import { bufferPointToFoldPoint, foldPointToBufferPoint, type FoldMap } from "../foldMap";
import {
  bufferColumnToVisualColumn,
  createDisplayRows,
  isDocumentTextDisplayRow,
  visualColumnToBufferColumn,
  type BlockRow,
  type DisplayRow,
  type DisplayTextRow,
  type InjectedTextRow,
} from "../displayTransforms";
import type { TextSnapshot } from "../documentTextSnapshot";
import type { TextEdit } from "../tokens";
import { clamp } from "../style-utils";
import { createLineStartOffsetIndex, type LineStartOffsetIndex } from "./lineStartIndex";
import {
  createRowHeightIndex,
  rowHeightIndexRowAtOffset,
  rowHeightIndexStart,
  type RowHeightIndex,
} from "./rowHeightIndex";
import {
  asFoldPoint,
  computeLineStarts,
  foldMapMatchesText,
  foldMarkersEqual,
  indexFoldMarkersByKey,
  indexFoldMarkersByStartRow,
  normalizeFoldMarkers,
  normalizeRowHeight,
} from "./virtualizedTextViewHelpers";
import type { FixedRowVirtualizerSnapshot } from "./fixedRowVirtualizer";
import type { SameLineEditPatch, VirtualizedFoldMarker } from "./virtualizedTextViewTypes";
import type { VirtualizedTextViewInternal } from "./virtualizedTextViewInternals";

export type FoldStateUpdate = {
  readonly foldMapChanged: boolean;
  readonly foldMarkersChanged: boolean;
  readonly changed: boolean;
};

export function setTextLayoutState(
  view: VirtualizedTextViewInternal,
  text: string,
  textSnapshot: TextSnapshot,
): { readonly lineCountChanged: boolean } {
  const previousLineCount = view.lineStarts.length;
  view.text = text;
  view.textSnapshot = textSnapshot;
  view.textLength = text.length;
  view.textRevision += 1;
  view.lineStarts = computeLineStarts(text);
  view.lineStartOffsetIndex = createLineStartOffsetIndex(view.lineStarts.length);
  view.foldMap = foldMapMatchesText(view.foldMap, view.textLength) ? view.foldMap : null;
  return { lineCountChanged: previousLineCount !== view.lineStarts.length };
}

export function applySameLineTextLayout(
  view: VirtualizedTextViewInternal,
  patch: SameLineEditPatch,
  textSnapshot: TextSnapshot,
): void {
  const delta = patch.text.length - patch.deleteLength;
  view.textSnapshot = textSnapshot;
  view.textLength = textSnapshot.length;
  view.textRevision += 1;
  view.foldMap = null;
  shiftLineStartsAfterRow(view, patch.rowIndex, delta);
  updateDisplayRowsAfterSameLineEdit(view, patch, delta);
}

export function setFoldStateLayout(
  view: VirtualizedTextViewInternal,
  markers: readonly VirtualizedFoldMarker[],
  foldMap: FoldMap | null,
): FoldStateUpdate {
  const nextFoldMap = foldMapMatchesText(foldMap, view.textLength) ? foldMap : null;
  const foldMapChanged = view.foldMap !== nextFoldMap;
  if (!foldMapChanged && markers.length === 0 && view.foldMarkers.length === 0) {
    return { foldMapChanged: false, foldMarkersChanged: false, changed: false };
  }

  const nextFoldMarkers = normalizeFoldMarkers(markers, view.textLength);
  const foldMarkersChanged = !foldMarkersEqual(view.foldMarkers, nextFoldMarkers);
  if (!foldMapChanged && !foldMarkersChanged) {
    return { foldMapChanged: false, foldMarkersChanged: false, changed: false };
  }

  if (foldMarkersChanged) {
    view.foldMarkers = nextFoldMarkers;
    view.foldMarkerByStartRow = indexFoldMarkersByStartRow(nextFoldMarkers);
    view.foldMarkerByKey = indexFoldMarkersByKey(nextFoldMarkers);
  }

  view.foldMap = nextFoldMap;
  return { foldMapChanged, foldMarkersChanged, changed: true };
}

export function rebuildDisplayRows(
  view: VirtualizedTextViewInternal,
  viewportColumns: number | null,
): void {
  materializeViewText(view);
  materializeLineStarts(view);
  view.currentWrapColumn = view.wrapEnabled ? viewportColumns : null;
  view.displayRows = createDisplayRows({
    text: view.text,
    lineStarts: view.lineStarts,
    visibleLineCount: foldVisibleLineCount(view),
    bufferRowForVisibleRow: (row) => foldBufferRowForVisibleRow(view, row),
    wrapColumn: view.currentWrapColumn,
    blocks: view.blockRows,
    injectedTextRows: view.injectedTextRows,
    tabSize: view.tabSize,
  });
}

export function refreshDisplayRowsForWrapWidth(
  view: VirtualizedTextViewInternal,
  viewportColumns: number,
): boolean {
  if (!view.wrapEnabled) return false;
  if (viewportColumns === view.currentWrapColumn) return false;

  rebuildDisplayRows(view, viewportColumns);
  return true;
}

export function setWrapEnabledLayout(
  view: VirtualizedTextViewInternal,
  enabled: boolean,
  viewportColumns: number | null,
): boolean {
  if (view.wrapEnabled === enabled) return false;

  view.wrapEnabled = enabled;
  view.currentWrapColumn = null;
  rebuildDisplayRows(view, viewportColumns);
  return true;
}

export function setBlockRowsLayout(
  view: VirtualizedTextViewInternal,
  blockRows: readonly BlockRow[],
  viewportColumns: number | null,
): void {
  view.blockRows = blockRows;
  rebuildDisplayRows(view, viewportColumns);
}

export function setInjectedTextRowsLayout(
  view: VirtualizedTextViewInternal,
  injectedTextRows: readonly InjectedTextRow[],
  viewportColumns: number | null,
): void {
  view.injectedTextRows = injectedTextRows;
  rebuildDisplayRows(view, viewportColumns);
}

export function updateVirtualizerRows(view: VirtualizedTextViewInternal): void {
  view.virtualizer.updateOptions({
    count: visibleLineCount(view),
    rowGap: view.rowGap,
    rowHeight: getRowHeight(view),
    rowSizes: rowSizes(view),
  });
}

export function rowSizes(view: VirtualizedTextViewInternal): readonly number[] | undefined {
  return variableRowHeightIndex(view)?.rowSizes;
}

export function hasVariableRows(view: VirtualizedTextViewInternal): boolean {
  for (const row of view.blockRows) {
    if (row.heightPx !== undefined && row.heightPx !== view.metrics.rowHeight) return true;
    if (normalizeBlockHeightRows(row.heightRows) !== 1) return true;
  }

  return false;
}

export function rowTop(view: VirtualizedTextViewInternal, row: number): number {
  const index = variableRowHeightIndex(view);
  if (!index) return row * rowStride(view);

  return rowHeightIndexStart(index, row);
}

export function rowHeight(view: VirtualizedTextViewInternal, row: number): number {
  return variableRowHeightIndex(view)?.rowSizes[row] ?? getRowHeight(view);
}

export function scrollPastEndPadding(
  view: VirtualizedTextViewInternal,
  viewportHeight: number,
): number {
  const lastRow = visibleLineCount(view) - 1;
  return Math.max(0, viewportHeight - rowHeight(view, lastRow));
}

export function scrollableHeight(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
): number {
  return snapshot.totalSize + scrollPastEndPadding(view, snapshot.viewportHeight);
}

export function displayRowKind(view: VirtualizedTextViewInternal, row: number): "text" | "block" {
  return view.displayRows[row]?.kind ?? "text";
}

export function visualColumnForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const row = rowForOffset(view, offset);
  const displayRow = view.displayRows[row];
  if (!isDocumentTextDisplayRow(displayRow)) return 0;

  const localOffset = clamp(offset - displayRowStartOffset(view, row), 0, displayRow.text.length);
  return bufferColumnToVisualColumn(displayRow.text, localOffset, view.tabSize);
}

export function offsetForViewportColumn(
  view: VirtualizedTextViewInternal,
  row: number,
  visualColumn: number,
): number {
  const displayRow = view.displayRows[row];
  if (!displayRow) return view.textLength;
  const startOffset = displayRowStartOffset(view, row);
  if (!isDocumentTextDisplayRow(displayRow)) return startOffset;

  const bufferColumn = visualColumnToBufferColumn(
    displayRow.text,
    visualColumn,
    "nearest",
    view.tabSize,
  );
  return startOffset + clamp(bufferColumn, 0, displayRow.text.length);
}

export function lineStartOffset(view: VirtualizedTextViewInternal, row: number): number {
  if (usesPlainDisplayRows(view)) return bufferLineStartOffset(view, row);
  return displayRowStartOffset(view, row);
}

export function lineEndOffset(view: VirtualizedTextViewInternal, row: number): number {
  if (usesPlainDisplayRows(view)) return bufferLineEndOffset(view, row);
  return displayRowEndOffset(view, row);
}

export function bufferLineStartOffset(view: VirtualizedTextViewInternal, row: number): number {
  if (row < 0 || row >= view.lineStarts.length) return view.textLength;
  const offsetIndex = lineStartOffsetIndex(view);
  return (view.lineStarts[row] ?? 0) + offsetIndex.offsetAt(row);
}

export function lineText(view: VirtualizedTextViewInternal, row: number): string {
  return view.displayRows[row]?.text ?? "";
}

function materializeViewText(view: VirtualizedTextViewInternal): void {
  const text = view.textSnapshot.getText();
  view.text = text;
  view.textLength = text.length;
}

function bufferLineEndOffset(view: VirtualizedTextViewInternal, row: number): number {
  if (row < 0) return view.textLength;
  if (row >= view.lineStarts.length - 1) return view.textLength;

  return Math.max(bufferLineStartOffset(view, row), bufferLineStartOffset(view, row + 1) - 1);
}

export function materializeLineStarts(view: VirtualizedTextViewInternal): readonly number[] {
  const offsetIndex = lineStartOffsetIndex(view);
  if (!offsetIndex.dirty) return view.lineStarts;

  view.lineStarts = offsetIndex.materialize(view.lineStarts);
  view.lineStartOffsetIndex = createLineStartOffsetIndex(view.lineStarts.length);
  return view.lineStarts;
}

function lineStartOffsetIndex(view: VirtualizedTextViewInternal): LineStartOffsetIndex {
  if (view.lineStartOffsetIndex) return view.lineStartOffsetIndex;

  view.lineStartOffsetIndex = createLineStartOffsetIndex(view.lineStarts.length);
  return view.lineStartOffsetIndex;
}

function shiftLineStartsAfterRow(
  view: VirtualizedTextViewInternal,
  rowIndex: number,
  delta: number,
): void {
  lineStartOffsetIndex(view).addSuffix(rowIndex + 1, delta);
}

function updateDisplayRowsAfterSameLineEdit(
  view: VirtualizedTextViewInternal,
  patch: SameLineEditPatch,
  delta: number,
): void {
  const row = view.displayRows[patch.rowIndex];
  if (!row) return;
  if (row.kind !== "text") return;

  view.displayRows[patch.rowIndex] = updateTextDisplayRow(row, patch, delta);
}

function updateTextDisplayRow(
  row: DisplayTextRow,
  patch: SameLineEditPatch,
  delta: number,
): DisplayTextRow {
  const suffixStart = patch.localFrom + patch.deleteLength;
  const text = `${row.text.slice(0, patch.localFrom)}${patch.text}${row.text.slice(suffixStart)}`;
  return {
    ...row,
    endOffset: row.endOffset + delta,
    text,
    sourceText: text,
    sourceEndColumn: row.sourceEndColumn + delta,
  };
}

export function sameLineEditPatch(
  view: VirtualizedTextViewInternal,
  edit: TextEdit,
): SameLineEditPatch | null {
  if (view.foldMap) return null;
  if (view.wrapEnabled || view.blockRows.length > 0 || view.injectedTextRows.length > 0)
    return null;
  if (edit.from < 0 || edit.to < edit.from || edit.to > view.textLength) return null;
  if (edit.text.includes("\n")) return null;
  if (view.textSnapshot.getTextInRange(edit.from, edit.to).includes("\n")) return null;

  const rowIndex = rowForOffset(view, edit.from);
  if (lineText(view, rowIndex).length > view.longLineChunkThreshold) return null;
  return {
    rowIndex,
    localFrom: edit.from - lineStartOffset(view, rowIndex),
    deleteLength: edit.to - edit.from,
    text: edit.text,
  };
}

export function rowForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const bufferRow = bufferRowForOffset(view, offset);
  if (!usesDisplayRowTransforms(view)) return foldVirtualRowForBufferRow(view, bufferRow);

  const displayRow = textDisplayRowForOffset(view, clamp(offset, 0, view.textLength));
  if (displayRow) return displayRow.index;

  return virtualRowForBufferRow(view, bufferRow);
}

export function bufferRowForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const clamped = clamp(offset, 0, view.textLength);
  let low = 0;
  let high = view.lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = bufferLineStartOffset(view, middle);
    const next = bufferLineStartOffset(view, middle + 1);
    if (clamped < start) {
      high = middle - 1;
      continue;
    }
    if (clamped >= next && middle + 1 < view.lineStarts.length) {
      low = middle + 1;
      continue;
    }
    return middle;
  }

  return view.lineStarts.length - 1;
}

export function rowForViewportY(view: VirtualizedTextViewInternal, y: number): number {
  const offset = view.scrollElement.scrollTop + y;
  const index = variableRowHeightIndex(view);
  if (!index) return fixedRowForOffset(view, offset);

  return rowHeightIndexRowAtOffset(index, offset);
}

export function visibleLineCount(view: VirtualizedTextViewInternal): number {
  return Math.max(1, view.displayRows.length);
}

export function foldVisibleLineCount(view: VirtualizedTextViewInternal): number {
  if (!view.foldMap) return view.lineStarts.length;

  const hidden = view.foldMap.ranges.reduce((count, range) => {
    return count + Math.max(0, range.endPoint.row - range.startPoint.row);
  }, 0);
  return Math.max(1, view.lineStarts.length - hidden);
}

export function bufferRowForVirtualRow(view: VirtualizedTextViewInternal, row: number): number {
  const displayRow = view.displayRows[row];
  if (displayRow?.kind === "text") return displayRow.bufferRow;
  if (displayRow?.kind === "block") return displayRow.anchorBufferRow;
  return foldBufferRowForVisibleRow(view, row);
}

export function foldBufferRowForVisibleRow(view: VirtualizedTextViewInternal, row: number): number {
  if (!view.foldMap) return clamp(row, 0, view.lineStarts.length - 1);
  const point = foldPointToBufferPoint(view.foldMap, asFoldPoint({ row, column: 0 }));
  return clamp(point.row, 0, view.lineStarts.length - 1);
}

export function virtualRowForBufferRow(view: VirtualizedTextViewInternal, row: number): number {
  if (!usesDisplayRowTransforms(view)) return foldVirtualRowForBufferRow(view, row);

  const match = textDisplayRowForBufferRow(view.displayRows, row);
  if (match) return match.index;

  return transformedRowForProjectedBufferRow(view, row);
}

export function foldVirtualRowForBufferRow(view: VirtualizedTextViewInternal, row: number): number {
  if (!view.foldMap) return clamp(row, 0, visibleLineCount(view) - 1);

  const point = bufferPointToFoldPoint(view.foldMap, { row, column: 0 });
  return clamp(point.row, 0, visibleLineCount(view) - 1);
}

export function getRowHeight(view: VirtualizedTextViewInternal): number {
  return normalizeRowHeight(view.metrics.rowHeight);
}

export function rowForSnapshotOffset(
  view: VirtualizedTextViewInternal,
  snapshot: FixedRowVirtualizerSnapshot,
  y: number,
): number {
  const offset = snapshot.scrollTop + y;
  const index = variableRowHeightIndex(view);
  if (!index) return fixedRowForOffset(view, offset);

  return rowHeightIndexRowAtOffset(index, offset);
}

function rowStride(view: VirtualizedTextViewInternal): number {
  return getRowHeight(view) + view.rowGap;
}

function fixedRowForOffset(view: VirtualizedTextViewInternal, offset: number): number {
  const rowHeight = getRowHeight(view);
  const stride = rowHeight + view.rowGap;
  const row = clamp(Math.floor(offset / stride), 0, visibleLineCount(view) - 1);
  const rowBottom = row * stride + rowHeight;
  if (offset < rowBottom) return row;

  return Math.min(row + 1, visibleLineCount(view) - 1);
}

function usesDisplayRowTransforms(view: VirtualizedTextViewInternal): boolean {
  if (view.wrapEnabled) return true;
  if (view.blockRows.length > 0) return true;
  return view.injectedTextRows.length > 0;
}

function usesPlainDisplayRows(view: VirtualizedTextViewInternal): boolean {
  if (view.foldMap) return false;
  return !usesDisplayRowTransforms(view);
}

function displayRowStartOffset(view: VirtualizedTextViewInternal, row: number): number {
  const displayRow = view.displayRows[row];
  if (!displayRow) return view.textLength;
  if (usesPlainDisplayRows(view) && isDocumentTextDisplayRow(displayRow))
    return bufferLineStartOffset(view, displayRow.bufferRow);

  return displayRow.startOffset;
}

function displayRowEndOffset(view: VirtualizedTextViewInternal, row: number): number {
  const displayRow = view.displayRows[row];
  if (!displayRow) return view.textLength;
  if (usesPlainDisplayRows(view) && isDocumentTextDisplayRow(displayRow))
    return bufferLineEndOffset(view, displayRow.bufferRow);

  return displayRow.endOffset;
}

function normalizeBlockHeightRows(heightRows: number): number {
  if (!Number.isFinite(heightRows) || heightRows <= 0) return 1;
  return Math.max(1, Math.floor(heightRows));
}

function blockRowHeightPx(row: DisplayRow, rowHeight: number): number {
  if (row.kind !== "block") return rowHeight;
  return row.heightPx ?? row.heightRows * rowHeight;
}

function variableRowHeightIndex(view: VirtualizedTextViewInternal): RowHeightIndex | null {
  const rowHeight = getRowHeight(view);
  if (cachedRowHeightIndexValid(view, rowHeight)) return view.rowHeightIndex;

  view.rowHeightIndexDisplayRows = view.displayRows;
  view.rowHeightIndexRowHeight = rowHeight;
  view.rowHeightIndexRowGap = view.rowGap;
  view.rowHeightIndexVariable = hasVariableRows(view);
  view.rowHeightIndex = view.rowHeightIndexVariable
    ? createRowHeightIndex(createRowSizes(view.displayRows, rowHeight), view.rowGap)
    : null;
  return view.rowHeightIndex;
}

function cachedRowHeightIndexValid(view: VirtualizedTextViewInternal, rowHeight: number): boolean {
  if (view.rowHeightIndexVariable === null) return false;
  if (view.rowHeightIndexDisplayRows !== view.displayRows) return false;
  if (view.rowHeightIndexRowHeight !== rowHeight) return false;
  return view.rowHeightIndexRowGap === view.rowGap;
}

function createRowSizes(rows: readonly DisplayRow[], rowHeight: number): readonly number[] {
  const sizes = Array.from({ length: rows.length }, () => rowHeight);
  for (let index = 0; index < rows.length; index += 1) {
    sizes[index] = blockRowHeightPx(rows[index]!, rowHeight);
  }

  return sizes;
}

function textDisplayRowForOffset(
  view: VirtualizedTextViewInternal,
  offset: number,
): DisplayTextRow | null {
  const rows = view.displayRows;
  const start = firstDisplayRowEndingAtOrAfter(rows, offset);
  if (start === -1) return null;

  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.startOffset > offset) return null;
    if (!isDocumentTextDisplayRow(row)) continue;
    if (offset <= row.endOffset) return row;
  }

  return null;
}

function firstDisplayRowEndingAtOrAfter(rows: readonly DisplayRow[], offset: number): number {
  let low = 0;
  let high = rows.length - 1;
  let result = rows.length;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle]!.endOffset >= offset) {
      result = middle;
      high = middle - 1;
      continue;
    }

    low = middle + 1;
  }

  if (result === rows.length) return -1;
  return result;
}

function textDisplayRowForBufferRow(
  rows: readonly DisplayRow[],
  bufferRow: number,
): DisplayTextRow | null {
  const start = firstDisplayRowAtOrAfterBufferRow(rows, bufferRow);
  if (start === -1) return null;

  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]!;
    const orderRow = displayRowBufferOrder(row);
    if (orderRow > bufferRow) return null;
    if (isDocumentTextDisplayRow(row) && row.bufferRow === bufferRow) return row;
  }

  return null;
}

function firstDisplayRowAtOrAfterBufferRow(rows: readonly DisplayRow[], bufferRow: number): number {
  let low = 0;
  let high = rows.length - 1;
  let result = rows.length;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (displayRowBufferOrder(rows[middle]!) >= bufferRow) {
      result = middle;
      high = middle - 1;
      continue;
    }

    low = middle + 1;
  }

  if (result === rows.length) return -1;
  return result;
}

function displayRowBufferOrder(row: DisplayRow): number {
  if (row.kind === "text") return row.bufferRow;
  return row.anchorBufferRow;
}

function transformedRowForProjectedBufferRow(
  view: VirtualizedTextViewInternal,
  row: number,
): number {
  const foldedRow = foldVirtualRowForBufferRow(view, row);
  const bufferRow = foldBufferRowForVisibleRow(view, foldedRow);
  const match = textDisplayRowForBufferRow(view.displayRows, bufferRow);
  if (match) return match.index;

  return foldedRow;
}
