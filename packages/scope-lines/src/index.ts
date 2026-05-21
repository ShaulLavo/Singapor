import type {
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
  EditorVisibleRowSnapshot,
  VirtualizedFoldMarker,
} from "@editor/core";
import { createStringTextSnapshot } from "@editor/core";
import type { DocumentSessionChange } from "@editor/core";
import "./style.css";

export type ScopeLinesPluginOptions = {
  readonly enabled?: boolean;
  readonly className?: string;
  readonly minLineSpan?: number;
  readonly mode?: ScopeLinesMode;
  readonly showActive?: boolean;
};

export type ScopeLinesMode = "all" | "current";

type ResolvedScopeLinesOptions = {
  readonly enabled: boolean;
  readonly className?: string;
  readonly minLineSpan: number;
  readonly mode: ScopeLinesMode;
  readonly showActive: boolean;
};

type ScopeGuide = {
  readonly marker: VirtualizedFoldMarker;
  readonly column: number;
  readonly indentLevel: number;
  readonly containsCursor: boolean;
  readonly active: boolean;
};

type ScopeLineSegment = {
  readonly column: number;
  readonly indentLevel: number;
  readonly top: number;
  readonly height: number;
  readonly active: boolean;
};

type ScopeGuidePlacement = {
  readonly column: number;
  readonly indentLevel: number;
};

type ScopeGuideGeometry = ScopeGuidePlacement & {
  readonly marker: VirtualizedFoldMarker;
};

const DEFAULT_MIN_LINE_SPAN = 1;
const BODY_INDENT_PROBE_LINES = 24;
const SCOPE_LINE_COLOR_COUNT = 6;

export function createScopeLinesPlugin(options: ScopeLinesPluginOptions = {}): EditorPlugin {
  const resolved = resolveScopeLinesOptions(options);

  return {
    name: "scope-lines",
    activate(context) {
      return context.registerViewContribution({
        createContribution: (contributionContext) =>
          createScopeLinesContribution(contributionContext, resolved),
      });
    },
  };
}

function createScopeLinesContribution(
  context: EditorViewContributionContext,
  options: ResolvedScopeLinesOptions,
): EditorViewContribution | null {
  if (!options.enabled) return null;
  return new ScopeLinesContribution(context, options);
}

class ScopeLinesContribution implements EditorViewContribution {
  private readonly root: HTMLDivElement;
  private readonly options: ResolvedScopeLinesOptions;
  private pendingContentSnapshot: EditorViewSnapshot | null = null;
  private pendingContentFrame: number | null = null;
  private signature = "";

  public constructor(context: EditorViewContributionContext, options: ResolvedScopeLinesOptions) {
    this.options = options;
    this.root = createRoot(context, options);
    this.update(context.getSnapshot(), "document");
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    _change?: DocumentSessionChange | null,
  ): void {
    if (kind === "content") {
      this.scheduleContentUpdate(snapshot);
      return;
    }

    this.cancelContentUpdate();
    this.renderSnapshot(snapshot);
  }

  public dispose(): void {
    this.cancelContentUpdate();
    this.root.remove();
  }

  private scheduleContentUpdate(snapshot: EditorViewSnapshot): void {
    this.pendingContentSnapshot = snapshot;
    if (this.pendingContentFrame !== null) return;

    const view = this.root.ownerDocument.defaultView;
    if (!view?.requestAnimationFrame) {
      this.flushContentUpdate();
      return;
    }

    this.pendingContentFrame = view.requestAnimationFrame(this.flushContentUpdate);
  }

  private flushContentUpdate = (): void => {
    const snapshot = this.pendingContentSnapshot;
    this.pendingContentFrame = null;
    this.pendingContentSnapshot = null;
    if (!snapshot) return;

    this.renderSnapshot(snapshot);
  };

  private cancelContentUpdate(): void {
    const frame = this.pendingContentFrame;
    this.pendingContentFrame = null;
    this.pendingContentSnapshot = null;
    if (frame === null) return;

    this.root.ownerDocument.defaultView?.cancelAnimationFrame(frame);
  }

  private renderSnapshot(snapshot: EditorViewSnapshot): void {
    const signature = snapshotSignature(snapshot, this.options);
    if (signature === this.signature) return;

    this.signature = signature;
    renderScopeLines(this.root, snapshot, this.options);
  }
}

function resolveScopeLinesOptions(options: ScopeLinesPluginOptions): ResolvedScopeLinesOptions {
  return {
    enabled: options.enabled ?? true,
    className: options.className,
    minLineSpan: normalizeMinLineSpan(options.minLineSpan),
    mode: options.mode ?? "all",
    showActive: options.showActive ?? true,
  };
}

function normalizeMinLineSpan(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MIN_LINE_SPAN;
  if (!Number.isFinite(value)) return DEFAULT_MIN_LINE_SPAN;
  return Math.max(1, Math.floor(value));
}

function createRoot(
  context: EditorViewContributionContext,
  options: ResolvedScopeLinesOptions,
): HTMLDivElement {
  const root = context.container.ownerDocument.createElement("div");
  root.className = "editor-scope-lines";
  root.setAttribute("aria-hidden", "true");
  if (options.className) root.classList.add(options.className);
  context.scrollElement.appendChild(root);
  return root;
}

function renderScopeLines(
  root: HTMLDivElement,
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): void {
  root.style.setProperty("--editor-scope-lines-content-width", `${snapshot.contentWidth}px`);
  root.replaceChildren(...createSegmentElements(root.ownerDocument, snapshot, options));
}

function createSegmentElements(
  document: Document,
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): HTMLDivElement[] {
  const segments = scopeLineSegments(snapshot, options);
  return segments.map((segment) => createSegmentElement(document, segment, snapshot));
}

function createSegmentElement(
  document: Document,
  segment: ScopeLineSegment,
  snapshot: EditorViewSnapshot,
): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "editor-scope-line";
  element.dataset.editorScopeLineLevel = String(segment.indentLevel % SCOPE_LINE_COLOR_COUNT);
  element.style.left = `${segment.column * snapshot.metrics.characterWidth}px`;
  element.style.top = `${segment.top + 1}px`;
  element.style.height = `${Math.max(0, segment.height - 4)}px`;
  if (segment.active) element.classList.add("editor-scope-line-active");
  return element;
}

function scopeLineSegments(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): ScopeLineSegment[] {
  const guides = createScopeGuides(snapshot, options);
  const segments: ScopeLineSegment[] = [];
  for (const guide of guides) appendGuideSegments(segments, guide, snapshot.visibleRows);
  return segments;
}

function createScopeGuides(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): ScopeGuide[] {
  const guides: ScopeGuide[] = [];
  for (const marker of snapshot.foldMarkers) {
    const guide = createScopeGuide(marker, snapshot, options);
    if (guide) guides.push(guide);
  }
  if (options.mode === "all") return guides;
  return nearestCursorScopeGuides(guides);
}

function createScopeGuide(
  marker: VirtualizedFoldMarker,
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): ScopeGuide | null {
  const geometry = scopeGuideGeometry(marker, snapshot, options);
  if (!geometry) return null;

  const containsCursor = markerContainsCursor(marker, snapshot);

  return {
    marker,
    column: geometry.column,
    indentLevel: geometry.indentLevel,
    containsCursor,
    active: options.showActive && containsCursor,
  };
}

function scopeGuideGeometry(
  marker: VirtualizedFoldMarker,
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): ScopeGuideGeometry | null {
  if (marker.collapsed) return null;
  if (marker.endRow - marker.startRow < options.minLineSpan) return null;

  const placement = scopeGuidePlacement(marker, snapshot);
  if (placement.column < 0) return null;

  return {
    marker,
    column: placement.column,
    indentLevel: placement.indentLevel,
  };
}

function scopeGuidePlacement(
  marker: VirtualizedFoldMarker,
  snapshot: EditorViewSnapshot,
): ScopeGuidePlacement {
  const startIndent = lineIndentColumn(snapshot, marker.startRow);
  const bodyIndent = firstBodyIndentColumn(snapshot, marker);
  if (bodyIndent === null) return placementFromIndent(startIndent, startIndent, snapshot.tabSize);
  if (bodyIndent <= startIndent) {
    return placementFromIndent(startIndent, startIndent, snapshot.tabSize);
  }

  return placementFromIndent(
    Math.max(startIndent, bodyIndent - snapshot.tabSize),
    bodyIndent,
    snapshot.tabSize,
  );
}

function placementFromIndent(column: number, indent: number, tabSize: number): ScopeGuidePlacement {
  return {
    column,
    indentLevel: indentLevelForColumn(indent, tabSize),
  };
}

function indentLevelForColumn(column: number, tabSize: number): number {
  return Math.max(0, Math.floor(column / Math.max(1, tabSize)));
}

function firstBodyIndentColumn(
  snapshot: EditorViewSnapshot,
  marker: VirtualizedFoldMarker,
): number | null {
  const probeEnd = Math.min(marker.endRow, marker.startRow + BODY_INDENT_PROBE_LINES);
  for (let row = marker.startRow + 1; row <= probeEnd; row += 1) {
    const text = lineText(snapshot, row);
    if (isBlankLine(text)) continue;
    return indentColumn(text, snapshot.tabSize);
  }
  return null;
}

function lineIndentColumn(snapshot: EditorViewSnapshot, row: number): number {
  return indentColumn(lineText(snapshot, row), snapshot.tabSize);
}

function lineText(snapshot: EditorViewSnapshot, row: number): string {
  const start = snapshot.lineStarts[row];
  if (start === undefined) return "";

  const textSnapshot = snapshot.textSnapshot ?? createStringTextSnapshot(snapshot.text);
  const nextStart = snapshot.lineStarts[row + 1] ?? textSnapshot.length + 1;
  const end = Math.max(start, Math.min(textSnapshot.length, nextStart - 1));
  return textSnapshot.getTextInRange(start, end);
}

function isBlankLine(text: string): boolean {
  return text.trim().length === 0;
}

function indentColumn(text: string, tabSize: number): number {
  let column = 0;
  for (const character of text) {
    if (character === " ") {
      column += 1;
      continue;
    }
    if (character !== "\t") return column;
    column += tabSize - (column % tabSize);
  }
  return column;
}

function markerContainsCursor(
  marker: VirtualizedFoldMarker,
  snapshot: EditorViewSnapshot,
): boolean {
  const cursor = snapshot.selections[0]?.headOffset;
  if (cursor === undefined) return false;
  return markerContainsOffset(marker, cursor);
}

function markerContainsOffset(marker: VirtualizedFoldMarker, offset: number): boolean {
  return offset > marker.startOffset && offset < marker.endOffset;
}

function nearestCursorScopeGuides(guides: readonly ScopeGuide[]): ScopeGuide[] {
  const nearest = guides.reduce<ScopeGuide | null>(nearestCursorScopeGuide, null);
  return nearest ? [nearest] : [];
}

function nearestCursorScopeGuide(
  current: ScopeGuide | null,
  candidate: ScopeGuide,
): ScopeGuide | null {
  if (!candidate.containsCursor) return current;
  if (!current) return candidate;

  const currentSpan = current.marker.endOffset - current.marker.startOffset;
  const candidateSpan = candidate.marker.endOffset - candidate.marker.startOffset;
  if (candidateSpan >= currentSpan) return current;
  return candidate;
}

function appendGuideSegments(
  segments: ScopeLineSegment[],
  guide: ScopeGuide,
  visibleRows: readonly EditorVisibleRowSnapshot[],
): void {
  let open: ScopeLineSegment | null = null;
  for (const row of visibleRows) {
    const rowSegment = guideSegmentForRow(guide, row);
    if (!rowSegment) {
      if (open) segments.push(open);
      open = null;
      continue;
    }

    if (open && canMergeSegments(open, rowSegment)) {
      const merged: ScopeLineSegment = open;
      open = { ...merged, height: rowSegment.top + rowSegment.height - merged.top };
      continue;
    }
    if (open) segments.push(open);
    open = rowSegment;
  }

  if (open) segments.push(open);
}

function guideSegmentForRow(
  guide: ScopeGuide,
  row: EditorVisibleRowSnapshot,
): ScopeLineSegment | null {
  if (row.kind !== "text") return null;
  if (row.bufferRow <= guide.marker.startRow) return null;
  if (row.bufferRow >= guide.marker.endRow) return null;

  return {
    column: guide.column,
    indentLevel: guide.indentLevel,
    top: row.top,
    height: row.height,
    active: guide.active,
  };
}

function canMergeSegments(left: ScopeLineSegment, right: ScopeLineSegment): boolean {
  if (left.column !== right.column) return false;
  if (left.indentLevel !== right.indentLevel) return false;
  if (left.active !== right.active) return false;
  return Math.abs(left.top + left.height - right.top) < 0.5;
}

function snapshotSignature(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): string {
  return [
    snapshot.contentWidth,
    snapshot.metrics.characterWidth,
    snapshot.tabSize,
    options.minLineSpan,
    options.mode,
    options.showActive,
    scopeGuideSignature(snapshot, options),
    visibleRowSignature(snapshot.visibleRows),
  ].join("|");
}

function scopeGuideSignature(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): string {
  if (options.mode === "current") return currentScopeGuideSignature(snapshot, options);

  const geometry = scopeGuideGeometrySignature(snapshot, options);
  if (!options.showActive) return geometry;

  return `${geometry}/${activeScopeGuideSignature(snapshot, options)}`;
}

function scopeGuideGeometrySignature(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): string {
  return scopeGuideGeometries(snapshot, options).map(scopeGuideGeometryKey).join(",");
}

function currentScopeGuideSignature(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): string {
  const current = nearestCursorScopeGuideGeometry(snapshot, options);
  return current ? scopeGuideGeometryKey(current) : "";
}

function activeScopeGuideSignature(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): string {
  return cursorScopeGuideGeometries(snapshot, options).map(scopeGuideGeometryKey).join(",");
}

function scopeGuideGeometries(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): ScopeGuideGeometry[] {
  const guides: ScopeGuideGeometry[] = [];
  for (const marker of snapshot.foldMarkers) {
    const guide = scopeGuideGeometry(marker, snapshot, options);
    if (guide) guides.push(guide);
  }
  return guides;
}

function cursorScopeGuideGeometries(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): ScopeGuideGeometry[] {
  const cursor = snapshot.selections[0]?.headOffset;
  if (cursor === undefined) return [];

  const guides: ScopeGuideGeometry[] = [];
  for (const marker of snapshot.foldMarkers) {
    if (!markerContainsOffset(marker, cursor)) continue;

    const guide = scopeGuideGeometry(marker, snapshot, options);
    if (guide) guides.push(guide);
  }
  return guides;
}

function nearestCursorScopeGuideGeometry(
  snapshot: EditorViewSnapshot,
  options: ResolvedScopeLinesOptions,
): ScopeGuideGeometry | null {
  return cursorScopeGuideGeometries(snapshot, options).reduce<ScopeGuideGeometry | null>(
    nearestScopeGuideGeometry,
    null,
  );
}

function nearestScopeGuideGeometry(
  current: ScopeGuideGeometry | null,
  candidate: ScopeGuideGeometry,
): ScopeGuideGeometry | null {
  if (!current) return candidate;

  const currentSpan = current.marker.endOffset - current.marker.startOffset;
  const candidateSpan = candidate.marker.endOffset - candidate.marker.startOffset;
  if (candidateSpan >= currentSpan) return current;
  return candidate;
}

function scopeGuideGeometryKey(guide: ScopeGuideGeometry): string {
  return [guide.marker.startRow, guide.marker.endRow, guide.column, guide.indentLevel].join(":");
}

function visibleRowSignature(rows: readonly EditorVisibleRowSnapshot[]): string {
  return rows
    .map((row) => [row.index, row.bufferRow, row.top, row.height, row.kind].join(":"))
    .join(",");
}
