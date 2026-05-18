import {
  createPieceTableSnapshot,
  VirtualizedTextView,
  type EditorToken,
  type VirtualizedTextHighlightRange,
  type VirtualizedTextRowDecoration,
} from "@editor/core";
import { canUseShikiWorker, createShikiHighlighterSession } from "@editor/core/shiki";
import { ResizablePaneGroup, type ResizablePaneLayout } from "@editor/panes";
import { createDiffCanvasGutterRenderer, type DiffCanvasGutterRenderer } from "./canvasGutter";
import { diffGutterWidth } from "./gutters";
import { joinRenderLines, languageIdForPath } from "./lines";
import { createSplitProjection, createStackedProjection } from "./projection";
import type {
  DiffFile,
  DiffHunkLocation,
  DiffRenderRow,
  DiffSyntaxBackend,
  DiffSplitPaneLayout,
  DiffViewMode,
  DiffViewOptions,
} from "./types";

type MountedPane = {
  rows: readonly DiffRenderRow[];
  syntaxGeneration: number;
  tokens?: readonly EditorToken[];
  readonly side: "old" | "new" | "stacked";
  readonly view: VirtualizedTextView;
  readonly disposeEvents: () => void;
  readonly gutterRenderer: DiffCanvasGutterRenderer;
  syntaxSession?: { dispose(): void };
};

type PaneSelectionDrag = {
  readonly anchorOffset: number;
  readonly getRows: () => readonly DiffRenderRow[];
  readonly view: VirtualizedTextView;
  headOffset: number;
};

type PaneSelection = {
  readonly anchorOffset: number;
  readonly getRows: () => readonly DiffRenderRow[];
  readonly view: VirtualizedTextView;
  headOffset: number;
};

const DEFAULT_THEME = "github-dark";
const DEFAULT_DIFF_OVERSCAN = 8;
const WHEEL_LINE_DELTA = 40;
let nextDiffViewId = 0;

export class DiffView {
  private readonly root: HTMLDivElement;
  private readonly fileList: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly highlightPrefix: string;
  private readonly options: DiffViewOptions;
  private files: readonly DiffFile[] = [];
  private selectedPath: string | null = null;
  private mode: DiffViewMode;
  private panes: MountedPane[] = [];
  private paneGroup: ResizablePaneGroup | null = null;
  private hunkRows: ReadonlyMap<number, number> = new Map();
  private expandedHunksByPath = new Map<string, Set<number>>();
  private disposeScrollSync: (() => void) | null = null;
  private syncingScroll = false;
  private paneSelection: PaneSelection | null = null;
  private paneSelectionDrag: PaneSelectionDrag | null = null;

  constructor(container: HTMLElement, options: DiffViewOptions = {}) {
    this.options = options;
    this.mode = options.mode ?? "split";
    this.highlightPrefix = `editor-diff-${nextDiffViewId++}`;
    this.root = container.ownerDocument.createElement("div");
    this.fileList = container.ownerDocument.createElement("div");
    this.content = container.ownerDocument.createElement("div");
    this.root.className = "editor-diff-view";
    this.fileList.className = "editor-diff-file-list";
    this.content.className = "editor-diff-content";
    if (this.options.showFileList !== false) this.root.append(this.fileList);
    this.root.append(this.content);
    container.appendChild(this.root);
  }

  setFiles(files: readonly DiffFile[]): void {
    this.files = [...files];
    this.selectedPath = selectedPathForFiles(this.files, this.selectedPath);
    this.render();
  }

  setMode(mode: DiffViewMode): void {
    if (this.mode === mode) return;

    this.mode = mode;
    this.renderSelectedFile();
  }

  setSelectedFile(path: string): void {
    if (this.selectedPath === path) return;
    if (!this.files.some((file) => file.path === path)) return;

    this.selectedPath = path;
    this.render();
  }

  revealNextHunk(options: { readonly wrap?: boolean } = {}): boolean {
    const locations = this.selectedHunkLocations();
    const position = this.currentHunkPosition(locations);
    const next = locations[position + 1] ?? null;
    if (next) return this.revealHunk(next.index);
    if (!options.wrap) return false;

    const first = locations[0] ?? null;
    return first ? this.revealHunk(first.index) : false;
  }

  revealPreviousHunk(options: { readonly wrap?: boolean } = {}): boolean {
    const locations = this.selectedHunkLocations();
    const position = this.currentHunkPosition(locations);
    const previous = locations[position - 1] ?? null;
    if (previous) return this.revealHunk(previous.index);
    if (!options.wrap) return false;

    const last = locations.at(-1) ?? null;
    return last ? this.revealHunk(last.index) : false;
  }

  revealHunk(index: number): boolean {
    const row = this.hunkRows.get(index);
    if (row === undefined) return false;

    for (const pane of this.panes) pane.view.scrollToRow(row);
    return true;
  }

  getCurrentHunk(): DiffHunkLocation | null {
    const locations = this.selectedHunkLocations();
    const position = this.currentHunkPosition(locations);
    return locations[position] ?? null;
  }

  dispose(): void {
    this.disposePanes();
    this.root.remove();
  }

  private render(): void {
    this.renderFileList();
    this.renderSelectedFile();
  }

  private renderFileList(): void {
    if (this.options.showFileList === false) return;

    this.fileList.textContent = "";
    for (const file of this.files) this.fileList.appendChild(this.createFileButton(file));
  }

  private createFileButton(file: DiffFile): HTMLButtonElement {
    const button = this.root.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "editor-diff-file-button";
    button.textContent = file.path;
    button.dataset.changeType = file.changeType;
    button.setAttribute("aria-pressed", String(file.path === this.selectedPath));
    button.addEventListener("click", () => this.setSelectedFile(file.path));
    return button;
  }

  private renderSelectedFile(): void {
    this.disposePanes();
    this.content.textContent = "";
    const file = this.selectedFile();
    if (!file) {
      this.renderEmptyState("No diff files");
      return;
    }

    if (this.mode === "stacked") {
      this.renderStackedFile(file);
      return;
    }

    this.renderSplitFile(file);
  }

  private renderSplitFile(file: DiffFile): void {
    const projection = createSplitProjection(file, {
      expandedHunks: this.expandedHunksForFile(file),
    });
    this.hunkRows = projection.hunkRows;
    const split = this.root.ownerDocument.createElement("div");
    split.className = "editor-diff-split";
    this.content.appendChild(split);
    const left = this.createPane(split, "old", projection.leftRows, file);
    const right = this.createPane(split, "new", projection.rightRows, file);
    this.panes = [left, right];
    this.paneGroup = this.createSplitPaneGroup(split, left, right, file);
    this.disposeScrollSync = this.installScrollSync(left.view, right.view);
  }

  private createSplitPaneGroup(
    split: HTMLElement,
    left: MountedPane,
    right: MountedPane,
    file: DiffFile,
  ): ResizablePaneGroup {
    const splitPane = this.options.splitPane;
    return new ResizablePaneGroup(split, {
      id: `${this.highlightPrefix}-split`,
      panes: [
        {
          id: "old",
          element: left.view.scrollElement.parentElement ?? left.view.scrollElement,
          minSize: splitPane?.minSize?.old,
          maxSize: splitPane?.maxSize?.old,
        },
        {
          id: "new",
          element: right.view.scrollElement.parentElement ?? right.view.scrollElement,
          minSize: splitPane?.minSize?.new,
          maxSize: splitPane?.maxSize?.new,
        },
      ],
      defaultLayout: splitDefaultLayout(splitPane?.defaultLayout),
      createHandle: splitPane?.createHandle
        ? (context) =>
            splitPane.createHandle?.({ ...context, file }) ?? context.document.createElement("div")
        : (context) => createDefaultSplitHandle(context.document),
      onLayoutChange: splitPane?.onLayoutChange
        ? (layout) => splitPane.onLayoutChange?.(diffSplitLayout(layout), file)
        : undefined,
      onLayoutChanged: splitPane?.onLayoutChanged
        ? (layout) => splitPane.onLayoutChanged?.(diffSplitLayout(layout), file)
        : undefined,
      disabled: splitPane?.disabled,
    });
  }

  private renderStackedFile(file: DiffFile): void {
    const projection = createStackedProjection(file, {
      expandedHunks: this.expandedHunksForFile(file),
    });
    this.hunkRows = projection.hunkRows;
    const pane = this.createPane(this.content, "stacked", projection.rows, file);
    this.panes = [pane];
  }

  private createPane(
    parent: HTMLElement,
    side: "old" | "new" | "stacked",
    rows: readonly DiffRenderRow[],
    file: DiffFile,
  ): MountedPane {
    const host = this.root.ownerDocument.createElement("div");
    host.className = `editor-diff-pane editor-diff-pane-${side}`;
    parent.appendChild(host);
    let mountedPane: MountedPane | null = null;
    const getRows = () => mountedPane?.rows ?? rows;
    let gutterRenderer: DiffCanvasGutterRenderer | null = null;
    const view = new VirtualizedTextView(host, {
      className: "editor-diff-text editor-virtualized",
      gutterWidth: (context) =>
        diffGutterWidth(side, getRows(), context.lineCount, context.metrics.characterWidth),
      lineHeight: this.options.lineHeight,
      onViewportChange: () => gutterRenderer?.render(),
      overscan: this.options.overscan ?? DEFAULT_DIFF_OVERSCAN,
      selectionHighlightName: `${this.highlightPrefix}-${side}-selection`,
      tabSize: this.options.tabSize,
    });
    gutterRenderer = createDiffCanvasGutterRenderer(view, getRows, side);
    view.scrollElement.tabIndex = -1;
    view.setEditable(false);
    view.setTheme(this.options.theme);
    view.setText(joinRenderLines(rows));
    view.setRowDecorations(rowDecorations(rows));
    view.setRangeHighlight(this.inlineHighlightName(side), inlineHighlightRanges(rows), {
      backgroundColor: "rgba(255, 255, 255, 0.18)",
    });
    const disposeEvents = this.installPaneInteractions(view, getRows);
    mountedPane = { view, rows, side, disposeEvents, gutterRenderer, syntaxGeneration: 0 };
    gutterRenderer.render();
    this.refreshSyntaxHighlighting(mountedPane, file);
    return mountedPane;
  }

  private installPaneInteractions(
    view: VirtualizedTextView,
    getRows: () => readonly DiffRenderRow[],
  ): () => void {
    const onCopy = (event: ClipboardEvent) => this.handlePaneCopy(event, view, getRows);
    const onClick = (event: MouseEvent) => this.handlePaneClick(event, view, getRows);
    const onMouseDown = (event: MouseEvent) => this.handlePaneMouseDown(event, view, getRows);
    const onMouseLeave = () => this.clearPaneCursor(view);
    const onMouseMove = (event: MouseEvent) => this.updatePaneCursor(event, view, getRows);
    view.scrollElement.addEventListener("copy", onCopy);
    view.scrollElement.addEventListener("click", onClick);
    view.scrollElement.addEventListener("mousedown", onMouseDown);
    view.scrollElement.addEventListener("mouseleave", onMouseLeave);
    view.scrollElement.addEventListener("mousemove", onMouseMove);
    return () => {
      view.scrollElement.removeEventListener("copy", onCopy);
      view.scrollElement.removeEventListener("click", onClick);
      view.scrollElement.removeEventListener("mousedown", onMouseDown);
      view.scrollElement.removeEventListener("mouseleave", onMouseLeave);
      view.scrollElement.removeEventListener("mousemove", onMouseMove);
    };
  }

  private handlePaneMouseDown(
    event: MouseEvent,
    view: VirtualizedTextView,
    getRows: () => readonly DiffRenderRow[],
  ): void {
    if (event.button !== 0) return;
    if (event.detail !== 1) return;
    if (event.defaultPrevented) return;
    if (this.isHunkTogglePointerEvent(event, view, getRows)) {
      event.preventDefault();
      return;
    }

    const offset = this.textOffsetFromPanePoint(view, event.clientX, event.clientY);
    event.preventDefault();
    view.scrollElement.focus({ preventScroll: true });
    view.scrollElement.ownerDocument.getSelection()?.removeAllRanges();
    this.clearPaneSelection(view);
    this.paneSelectionDrag = {
      anchorOffset: offset,
      getRows,
      headOffset: offset,
      view,
    };
    this.setPaneSelection(view, getRows, offset, offset);
    view.scrollElement.ownerDocument.addEventListener("mousemove", this.updatePaneSelectionDrag);
    view.scrollElement.ownerDocument.addEventListener("mouseup", this.finishPaneSelectionDrag);
  }

  private updatePaneSelectionDrag = (event: MouseEvent): void => {
    const drag = this.paneSelectionDrag;
    if (!drag) return;

    event.preventDefault();
    drag.headOffset = this.textOffsetFromPanePoint(drag.view, event.clientX, event.clientY);
    this.setPaneSelection(drag.view, drag.getRows, drag.anchorOffset, drag.headOffset);
  };

  private finishPaneSelectionDrag = (event: MouseEvent): void => {
    const drag = this.paneSelectionDrag;
    if (!drag) {
      this.stopPaneSelectionDrag();
      return;
    }

    event.preventDefault();
    drag.headOffset = this.textOffsetFromPanePoint(drag.view, event.clientX, event.clientY);
    this.setPaneSelection(drag.view, drag.getRows, drag.anchorOffset, drag.headOffset);
    this.stopPaneSelectionDrag();
  };

  private stopPaneSelectionDrag(): void {
    const drag = this.paneSelectionDrag;
    this.paneSelectionDrag = null;
    const document = drag?.view.scrollElement.ownerDocument;
    document?.removeEventListener("mousemove", this.updatePaneSelectionDrag);
    document?.removeEventListener("mouseup", this.finishPaneSelectionDrag);
  }

  private setPaneSelection(
    view: VirtualizedTextView,
    getRows: () => readonly DiffRenderRow[],
    anchorOffset: number,
    headOffset: number,
  ): void {
    view.setSelection(anchorOffset, headOffset);
    this.paneSelection = { anchorOffset, getRows, headOffset, view };
  }

  private clearPaneSelection(except?: VirtualizedTextView): void {
    const selection = this.paneSelection;
    if (!selection) return;
    if (selection.view === except) return;

    selection.view.clearSelection();
    this.paneSelection = null;
  }

  private handlePaneCopy(
    event: ClipboardEvent,
    view: VirtualizedTextView,
    getRows: () => readonly DiffRenderRow[],
  ): void {
    const selection = this.paneSelection;
    if (!selection) return;
    if (selection.view !== view) return;

    const text = selectedPaneText(selection, getRows());
    if (text.length === 0) return;

    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
  }

  private textOffsetFromPanePoint(
    view: VirtualizedTextView,
    clientX: number,
    clientY: number,
  ): number {
    return (
      view.textOffsetFromPoint(clientX, clientY) ??
      view.textOffsetFromViewportPoint(clientX, clientY) ??
      0
    );
  }

  private updatePaneCursor(
    event: MouseEvent,
    view: VirtualizedTextView,
    getRows: () => readonly DiffRenderRow[],
  ): void {
    const cursor = this.isHunkTogglePointerEvent(event, view, getRows) ? "pointer" : "";
    if (view.scrollElement.style.cursor === cursor) return;

    view.scrollElement.style.cursor = cursor;
  }

  private clearPaneCursor(view: VirtualizedTextView): void {
    if (!view.scrollElement.style.cursor) return;

    view.scrollElement.style.cursor = "";
  }

  private handlePaneClick(
    event: MouseEvent,
    view: VirtualizedTextView,
    getRows: () => readonly DiffRenderRow[],
  ): void {
    const rowIndex = paneClickRowIndex(event, view);
    if (rowIndex === null) return;

    this.toggleRowHunk(getRows()[rowIndex]);
  }

  private isHunkTogglePointerEvent(
    event: MouseEvent,
    view: VirtualizedTextView,
    getRows: () => readonly DiffRenderRow[],
  ): boolean {
    const rowIndex = paneClickRowIndex(event, view);
    if (rowIndex === null) return false;

    const row = getRows()[rowIndex];
    if (row?.type !== "hunk") return false;
    return Boolean(row.expandable);
  }

  private toggleRowHunk(row: DiffRenderRow | undefined): void {
    if (row?.type !== "hunk") return;
    if (!row.expandable) return;
    if (row.hunkIndex === undefined) return;

    const file = this.selectedFile();
    if (!file) return;

    toggleSetValue(this.mutableExpandedHunksForFile(file), row.hunkIndex);
    this.updateSelectedFilePanes(file);
  }

  private updateSelectedFilePanes(file: DiffFile): void {
    if (this.mode === "stacked") {
      this.updateStackedFile(file);
      return;
    }

    this.updateSplitFile(file);
  }

  private updateSplitFile(file: DiffFile): void {
    const left = this.panes[0];
    const right = this.panes[1];
    if (!left || !right || left.side !== "old" || right.side !== "new") {
      this.renderSelectedFile();
      return;
    }

    const projection = createSplitProjection(file, {
      expandedHunks: this.expandedHunksForFile(file),
    });
    this.hunkRows = projection.hunkRows;
    this.updatePaneRows(left, projection.leftRows, file);
    this.updatePaneRows(right, projection.rightRows, file);
  }

  private updateStackedFile(file: DiffFile): void {
    const pane = this.panes[0];
    if (!pane || pane.side !== "stacked") {
      this.renderSelectedFile();
      return;
    }

    const projection = createStackedProjection(file, {
      expandedHunks: this.expandedHunksForFile(file),
    });
    this.hunkRows = projection.hunkRows;
    this.updatePaneRows(pane, projection.rows, file);
  }

  private updatePaneRows(pane: MountedPane, rows: readonly DiffRenderRow[], file: DiffFile): void {
    this.clearPaneSelection();
    pane.rows = rows;
    pane.view.setText(joinRenderLines(rows));
    pane.view.refreshGutterWidth();
    if (pane.tokens) pane.view.setTokens(pane.tokens);
    pane.view.setRowDecorations(rowDecorations(rows));
    pane.view.setRangeHighlight(this.inlineHighlightName(pane.side), inlineHighlightRanges(rows), {
      backgroundColor: "rgba(255, 255, 255, 0.18)",
    });
    pane.gutterRenderer.render();
    this.refreshSyntaxHighlighting(pane, file);
  }

  private installScrollSync(left: VirtualizedTextView, right: VirtualizedTextView): () => void {
    const leftElement = left.scrollElement;
    const rightElement = right.scrollElement;
    let pendingFrame = 0;
    let pendingSource: HTMLElement | null = null;
    let pendingTarget: HTMLElement | null = null;

    const onLeftWheel = (event: WheelEvent) =>
      this.syncWheelScroll(event, leftElement, rightElement);
    const onRightWheel = (event: WheelEvent) =>
      this.syncWheelScroll(event, rightElement, leftElement);
    const onLeftScroll = () => {
      if (this.syncingScroll) return;

      pendingSource = leftElement;
      pendingTarget = rightElement;
      pendingFrame ||=
        this.root.ownerDocument.defaultView?.requestAnimationFrame(flushPendingScroll) ?? 0;
    };
    const onRightScroll = () => {
      if (this.syncingScroll) return;

      pendingSource = rightElement;
      pendingTarget = leftElement;
      pendingFrame ||=
        this.root.ownerDocument.defaultView?.requestAnimationFrame(flushPendingScroll) ?? 0;
    };
    const flushPendingScroll = () => {
      pendingFrame = 0;
      if (!pendingSource || !pendingTarget) return;

      this.syncScrollElements(pendingSource, pendingTarget);
      pendingSource = null;
      pendingTarget = null;
    };

    leftElement.addEventListener("wheel", onLeftWheel, { passive: false });
    rightElement.addEventListener("wheel", onRightWheel, { passive: false });
    leftElement.addEventListener("scroll", onLeftScroll);
    rightElement.addEventListener("scroll", onRightScroll);

    return () => {
      const view = this.root.ownerDocument.defaultView;
      if (pendingFrame) view?.cancelAnimationFrame(pendingFrame);
      leftElement.removeEventListener("wheel", onLeftWheel);
      rightElement.removeEventListener("wheel", onRightWheel);
      leftElement.removeEventListener("scroll", onLeftScroll);
      rightElement.removeEventListener("scroll", onRightScroll);
    };
  }

  private syncWheelScroll(event: WheelEvent, source: HTMLElement, target: HTMLElement): void {
    if (!event.cancelable) return;

    const delta = normalizedWheelDelta(event, source);
    if (!delta.top && !delta.left) return;

    event.preventDefault();
    this.withScrollSync(() => {
      const beforeTop = source.scrollTop;
      const beforeLeft = source.scrollLeft;
      source.scrollTop += delta.top;
      source.scrollLeft += delta.left;
      target.scrollTop += source.scrollTop - beforeTop;
      target.scrollLeft += source.scrollLeft - beforeLeft;
    });
  }

  private syncScrollElements(source: HTMLElement, target: HTMLElement): void {
    this.withScrollSync(() => {
      target.scrollTop = source.scrollTop;
      target.scrollLeft = source.scrollLeft;
    });
  }

  private withScrollSync(sync: () => void): void {
    this.syncingScroll = true;
    sync();
    const view = this.root.ownerDocument.defaultView;
    if (!view) {
      this.syncingScroll = false;
      return;
    }

    view.requestAnimationFrame(() => (this.syncingScroll = false));
  }

  private renderEmptyState(text: string): void {
    const empty = this.root.ownerDocument.createElement("div");
    empty.className = "editor-diff-empty";
    empty.textContent = text;
    this.content.appendChild(empty);
    this.hunkRows = new Map();
  }

  private selectedFile(): DiffFile | null {
    return this.files.find((file) => file.path === this.selectedPath) ?? this.files[0] ?? null;
  }

  private selectedHunkLocations(): readonly DiffHunkLocation[] {
    const file = this.selectedFile();
    if (!file) return [];

    const locations = [...this.hunkRows].flatMap(([index, row]) => {
      const hunk = file.hunks[index];
      if (!hunk) return [];

      return [{ hunk, index, path: file.path, row }];
    });

    return locations.sort((left, right) => left.row - right.row);
  }

  private currentHunkPosition(locations: readonly DiffHunkLocation[]): number {
    const topRow = this.currentTopRow();
    let current = -1;

    for (const [position, location] of locations.entries()) {
      if (location.row > topRow) break;

      current = position;
    }

    return current;
  }

  private currentTopRow(): number {
    return this.panes[0]?.view.getState().visibleRange.start ?? 0;
  }

  private disposePanes(): void {
    this.stopPaneSelectionDrag();
    this.clearPaneSelection();
    this.paneGroup?.dispose();
    this.paneGroup = null;
    this.disposeScrollSync?.();
    this.disposeScrollSync = null;
    for (const pane of this.panes) {
      pane.disposeEvents();
      pane.syntaxSession?.dispose();
      pane.gutterRenderer.dispose();
      pane.view.dispose();
    }
    this.panes = [];
  }

  private expandedHunksForFile(file: DiffFile): ReadonlySet<number> {
    return this.expandedHunksByPath.get(file.path) ?? new Set();
  }

  private mutableExpandedHunksForFile(file: DiffFile): Set<number> {
    const existing = this.expandedHunksByPath.get(file.path);
    if (existing) return existing;

    const next = new Set<number>();
    this.expandedHunksByPath.set(file.path, next);
    return next;
  }

  private refreshSyntaxHighlighting(pane: MountedPane, file: DiffFile): void {
    pane.syntaxSession?.dispose();
    pane.syntaxSession = undefined;
    pane.syntaxGeneration += 1;
    const generation = pane.syntaxGeneration;
    void this.applySyntaxHighlighting(pane, file, generation).catch(() => undefined);
  }

  private async applySyntaxHighlighting(
    pane: MountedPane,
    file: DiffFile,
    generation: number,
  ): Promise<void> {
    if (this.options.syntaxHighlight === false) return;
    const syntaxBackend = diffSyntaxBackend(this.options);
    if (syntaxBackend.kind === "tree-sitter") {
      await this.applySyntaxProviderHighlighting(pane, file, generation, syntaxBackend);
      return;
    }

    await this.applyShikiHighlighting(pane, file, generation, syntaxBackend);
  }

  private async applySyntaxProviderHighlighting(
    pane: MountedPane,
    file: DiffFile,
    generation: number,
    backend: Extract<DiffSyntaxBackend, { readonly kind: "tree-sitter" }>,
  ): Promise<void> {
    if (!backend.provider) return;

    const sources = syntaxSourcesForPane(file, pane.side);
    const sessions: { dispose(): void }[] = [];
    const tokenSources: DiffSyntaxTokenSource[] = [];

    for (const source of sources) {
      const session = backend.provider.createSession({
        documentId: `${file.path}:${source.side}`,
        languageId: file.languageId ?? shikiLanguageForFile(file),
        text: source.text,
        snapshot: createPieceTableSnapshot(source.text),
      });
      if (!session) continue;

      if (pane.syntaxGeneration !== generation) {
        session.dispose();
        disposeSessions(sessions);
        return;
      }

      sessions.push(session);
      const result = await session.refresh(createPieceTableSnapshot(source.text), source.text);
      if (pane.syntaxGeneration !== generation) {
        disposeSessions(sessions);
        return;
      }

      tokenSources.push({
        lineStarts: source.lineStarts,
        side: source.side,
        tokens: result.tokens,
      });
    }

    pane.syntaxSession = { dispose: () => disposeSessions(sessions) };
    pane.view.setTheme(this.options.theme);
    pane.gutterRenderer.refreshStyle();
    pane.gutterRenderer.render();
    pane.tokens = projectDiffSyntaxTokens({
      rows: pane.rows,
      side: pane.side,
      sources: tokenSources,
    });
    pane.view.setTokens(pane.tokens);
  }

  private async applyShikiHighlighting(
    pane: MountedPane,
    file: DiffFile,
    generation: number,
    backend: Extract<DiffSyntaxBackend, { readonly kind: "shiki" }>,
  ): Promise<void> {
    if (!canUseShikiWorker()) return;

    const syntaxText = joinSyntaxLines(pane.rows);
    const lang = shikiLanguageForFile(file);
    if (!lang) return;

    const themeName = shikiThemeName(backend.shikiTheme);
    const snapshot = createPieceTableSnapshot(syntaxText);
    const session = createShikiHighlighterSession({
      documentId: `${file.path}:${pane.side}`,
      languageId: file.languageId ?? lang,
      text: syntaxText,
      snapshot,
      langs: [lang],
      lang,
      theme: themeName,
      themes: [themeName],
    });
    if (!session) return;

    if (pane.syntaxGeneration !== generation) {
      session.dispose();
      return;
    }

    pane.syntaxSession = session;
    const result = await session.refresh(snapshot, syntaxText);
    if (pane.syntaxGeneration !== generation) {
      session.dispose();
      return;
    }

    pane.view.setTheme(this.options.theme);
    pane.gutterRenderer.refreshStyle();
    pane.gutterRenderer.render();
    pane.tokens = result.tokens as readonly EditorToken[];
    pane.view.setTokens(pane.tokens);
  }

  private inlineHighlightName(side: MountedPane["side"]): string {
    return `${this.highlightPrefix}-${side}-inline`;
  }
}

function paneClickRowIndex(event: MouseEvent, view: VirtualizedTextView): number | null {
  const target = event.target;
  if (target instanceof Element) {
    const rowElement = target.closest<HTMLElement>("[data-editor-virtual-row]");
    if (rowElement) return Number(rowElement.dataset.editorVirtualRow);
  }

  return paneRowIndexFromPoint(view, event.clientY);
}

function paneRowIndexFromPoint(view: VirtualizedTextView, clientY: number): number | null {
  const bounds = view.scrollElement.getBoundingClientRect();
  if (clientY < bounds.top || clientY > bounds.bottom) return null;

  const y = clientY - bounds.top + view.scrollElement.scrollTop;
  const lineStarts = view.getLineStarts();
  for (const row of view.getState().mountedRows) {
    if (row.startOffset !== lineStarts[row.bufferRow]) continue;
    if (y < row.top || y >= row.top + row.height) continue;
    return row.bufferRow;
  }

  return null;
}

function selectedPathForFiles(files: readonly DiffFile[], current: string | null): string | null {
  if (current && files.some((file) => file.path === current)) return current;
  return files[0]?.path ?? null;
}

export function diffSyntaxBackend(options: DiffViewOptions): DiffSyntaxBackend {
  return options.syntaxBackend ?? { kind: "tree-sitter" };
}

function shikiThemeName(theme: string | (() => string) | undefined): string {
  if (typeof theme === "function") return theme();
  return theme ?? DEFAULT_THEME;
}

type DiffSyntaxSource = {
  readonly lineStarts: readonly number[];
  readonly side: DiffSyntaxSourceSide;
  readonly text: string;
};

type DiffSyntaxSourceSide = "old" | "new";

type DiffSyntaxTokenSource = {
  readonly lineStarts: readonly number[];
  readonly side: DiffSyntaxSourceSide;
  readonly tokens: readonly EditorToken[];
};

type ProjectDiffSyntaxTokensOptions = {
  readonly rows: readonly DiffRenderRow[];
  readonly side: MountedPane["side"];
  readonly sources: readonly DiffSyntaxTokenSource[];
};

function syntaxSourcesForPane(
  file: DiffFile,
  side: MountedPane["side"],
): readonly DiffSyntaxSource[] {
  if (side === "stacked") {
    return [syntaxSource(file.oldLines, "old"), syntaxSource(file.newLines, "new")];
  }

  return [syntaxSource(side === "old" ? file.oldLines : file.newLines, side)];
}

function syntaxSource(lines: readonly string[], side: DiffSyntaxSourceSide): DiffSyntaxSource {
  const text = lines.join("\n");
  return {
    lineStarts: lineStartsForLines(lines),
    side,
    text,
  };
}

export function projectDiffSyntaxTokens({
  rows,
  side,
  sources,
}: ProjectDiffSyntaxTokensOptions): readonly EditorToken[] {
  const projectedTokens: EditorToken[] = [];
  let rowOffset = 0;

  for (const row of rows) {
    const source = tokenSourceForRow(sources, row, side);
    if (source) {
      appendRowSyntaxTokens(projectedTokens, {
        lineStarts: source.lineStarts,
        row,
        rowOffset,
        side: source.side,
        tokens: source.tokens,
      });
    }
    rowOffset += row.text.length + 1;
  }

  return projectedTokens;
}

function tokenSourceForRow(
  sources: readonly DiffSyntaxTokenSource[],
  row: DiffRenderRow,
  side: MountedPane["side"],
): DiffSyntaxTokenSource | null {
  const sourceSide = sourceSideForRow(row, side);
  return sources.find((source) => source.side === sourceSide) ?? null;
}

function appendRowSyntaxTokens(
  projectedTokens: EditorToken[],
  {
    lineStarts,
    row,
    rowOffset,
    side,
    tokens,
  }: {
    readonly lineStarts: readonly number[];
    readonly row: DiffRenderRow;
    readonly rowOffset: number;
    readonly side: DiffSyntaxSourceSide;
    readonly tokens: readonly EditorToken[];
  },
): void {
  const lineNumber = sourceLineNumberForRow(row, side);
  if (lineNumber === undefined) return;

  const lineStart = lineStarts[lineNumber - 1];
  const nextLineStart = lineStarts[lineNumber];
  if (lineStart === undefined) return;

  const lineEnd = Math.min(
    nextLineStart === undefined ? Number.POSITIVE_INFINITY : nextLineStart - 1,
    lineStart + row.text.length,
  );

  for (const token of tokens) {
    appendProjectedToken(projectedTokens, token, lineStart, lineEnd, rowOffset);
  }
}

function appendProjectedToken(
  projectedTokens: EditorToken[],
  token: EditorToken,
  lineStart: number,
  lineEnd: number,
  rowOffset: number,
): void {
  if (token.end <= lineStart) return;
  if (token.start >= lineEnd) return;

  const start = Math.max(token.start, lineStart);
  const end = Math.min(token.end, lineEnd);
  if (end <= start) return;

  projectedTokens.push({
    end: rowOffset + end - lineStart,
    start: rowOffset + start - lineStart,
    style: token.style,
  });
}

function sourceLineNumberForRow(
  row: DiffRenderRow,
  side: DiffSyntaxSourceSide,
): number | undefined {
  if (side === "old") return row.oldLineNumber;
  return row.newLineNumber;
}

function sourceSideForRow(row: DiffRenderRow, side: MountedPane["side"]): DiffSyntaxSourceSide {
  if (side === "old" || side === "new") return side;
  if (row.type === "deletion") return "old";

  return "new";
}

function disposeSessions(sessions: readonly { dispose(): void }[]): void {
  for (const session of sessions) session.dispose();
}

function lineStartsForLines(lines: readonly string[]): readonly number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function toggleSetValue(set: Set<number>, value: number): void {
  if (set.delete(value)) return;

  set.add(value);
}

function selectedPaneText(selection: PaneSelection, rows: readonly DiffRenderRow[]): string {
  const start = Math.min(selection.anchorOffset, selection.headOffset);
  const end = Math.max(selection.anchorOffset, selection.headOffset);
  if (start === end) return "";

  return joinRenderLines(rows).slice(start, end);
}

function normalizedWheelDelta(
  event: WheelEvent,
  element: HTMLElement,
): { left: number; top: number } {
  const multiplier = wheelDeltaMultiplier(event, element);
  const top = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
  const left = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
  return {
    left: left * multiplier,
    top: top * multiplier,
  };
}

function wheelDeltaMultiplier(event: WheelEvent, element: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return WHEEL_LINE_DELTA;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return element.clientHeight;

  return 1;
}

function rowDecorations(
  rows: readonly DiffRenderRow[],
): ReadonlyMap<number, VirtualizedTextRowDecoration> {
  const decorations = new Map<number, VirtualizedTextRowDecoration>();
  for (const [index, row] of rows.entries()) decorations.set(index, decorationForRow(row));
  return decorations;
}

function inlineHighlightRanges(
  rows: readonly DiffRenderRow[],
): readonly VirtualizedTextHighlightRange[] {
  const ranges: VirtualizedTextHighlightRange[] = [];
  let offset = 0;

  for (const row of rows) {
    appendInlineRanges(ranges, row, offset);
    offset += row.text.length + 1;
  }

  return ranges;
}

function appendInlineRanges(
  ranges: VirtualizedTextHighlightRange[],
  row: DiffRenderRow,
  rowOffset: number,
): void {
  for (const range of row.inlineRanges ?? []) {
    if (range.end <= range.start) continue;
    ranges.push({ start: rowOffset + range.start, end: rowOffset + range.end });
  }
}

function decorationForRow(row: DiffRenderRow): VirtualizedTextRowDecoration {
  const suffix = row.type;
  const expandable = row.expandable ? " editor-diff-row-expandable" : "";
  return {
    className: `editor-diff-row editor-diff-row-${suffix}${expandable}`,
    gutterClassName: `editor-diff-gutter-row editor-diff-gutter-row-${suffix}`,
  };
}

function joinSyntaxLines(rows: readonly DiffRenderRow[]): string {
  return rows.map(syntaxLineText).join("\n");
}

function syntaxLineText(row: DiffRenderRow): string {
  if (row.type === "context" || row.type === "addition" || row.type === "deletion") {
    return row.text;
  }

  return " ".repeat(row.text.length);
}

function shikiLanguageForFile(file: DiffFile): string | null {
  const languageId = file.languageId ?? languageIdForPath(file.path);
  if (languageId === "typescript" && pathExtension(file.path) === ".tsx") return "tsx";
  if (languageId === "javascript" && pathExtension(file.path) === ".jsx") return "jsx";
  return languageId;
}

function pathExtension(path: string): string {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return "";
  return fileName.slice(dotIndex).toLowerCase();
}

function splitDefaultLayout(
  layout: Partial<DiffSplitPaneLayout> | undefined,
): ResizablePaneLayout | undefined {
  if (!layout) return undefined;
  if (layout.old !== undefined && layout.new !== undefined)
    return { old: layout.old, new: layout.new };
  if (layout.old !== undefined) return { old: layout.old, new: 100 - layout.old };
  if (layout.new !== undefined) return { old: 100 - layout.new, new: layout.new };
  return undefined;
}

function diffSplitLayout(layout: ResizablePaneLayout): DiffSplitPaneLayout {
  return {
    old: layout.old ?? 0,
    new: layout.new ?? 0,
  };
}

function createDefaultSplitHandle(document: Document): HTMLElement {
  const handle = document.createElement("div");
  const line = document.createElement("span");
  handle.className = "editor-diff-split-handle";
  line.className = "editor-diff-split-handle-line";
  line.setAttribute("aria-hidden", "true");
  handle.appendChild(line);
  return handle;
}
