import type {
  DocumentSessionChange,
  EditorMinimapDecoration,
  EditorToken,
  EditorViewSnapshot,
  TextEdit,
} from "@editor/core";
import { parseCssColor, RGBA_BLACK, RGBA_WHITE, transparent } from "./color";
import type {
  MinimapBaseStyles,
  MinimapDocumentEditPayload,
  MinimapDocumentPayload,
  MinimapMetrics,
  MinimapSelection,
  MinimapToken,
  MinimapTokenPatch,
  MinimapViewport,
  MinimapWorkerRequest,
  MinimapWorkerResponse,
  ResolvedMinimapOptions,
  RGBA8,
} from "./types";

const MINIMAP_UPDATE_QUIET_DELAY_MS = 120;
const MINIMAP_UPDATE_MAX_DELAY_MS = 300;

export type MinimapHost = {
  readonly root: HTMLDivElement;
  readonly colorScope: HTMLElement;
  readonly mainCanvas: HTMLCanvasElement;
  readonly decorationsCanvas: HTMLCanvasElement;
  readonly slider: HTMLDivElement;
  readonly sliderHorizontal: HTMLDivElement;
  readonly shadow: HTMLDivElement;
};

export type MinimapWorkerClientOptions = {
  readonly host: MinimapHost;
  readonly options: ResolvedMinimapOptions;
  readonly snapshot: EditorViewSnapshot;
  readonly decorations: readonly EditorMinimapDecoration[];
  readonly onLayoutWidth: (width: number) => void;
};

export class MinimapWorkerClient {
  private readonly host: MinimapHost;
  private readonly options: ResolvedMinimapOptions;
  private readonly worker: Worker;
  private readonly colorResolver: ColorResolver;
  private readonly onLayoutWidth: (width: number) => void;
  private externalDecorations: readonly EditorMinimapDecoration[];
  private sequence = 0;
  private latestRenderedSequence = 0;
  private pendingUpdate: PendingMinimapUpdate | null = null;
  private flushHandle = 0;
  private quietFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private maxFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private idleFlushHandle = 0;
  private renderInFlight = false;
  private latestSliderHeight = 0;
  private latestSliderNeeded = false;
  private latestBaseStyles: MinimapBaseStyles | null = null;
  private latestBaseStylesSignature = "";
  private latestLayoutSignature = "";
  private latestThemeSignature = "";
  private latestSnapshot: EditorViewSnapshot;
  private latestFullDocumentSnapshot: EditorViewSnapshot | null = null;
  private latestTokenSource: readonly EditorToken[] | null;
  private disposed = false;

  public constructor(options: MinimapWorkerClientOptions) {
    this.host = options.host;
    this.options = options.options;
    this.onLayoutWidth = options.onLayoutWidth;
    this.externalDecorations = options.decorations;
    this.latestSnapshot = options.snapshot;
    this.latestTokenSource = options.snapshot.tokens;
    this.colorResolver = new ColorResolver(options.host.colorScope);
    this.worker = new Worker(new URL("./minimap.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = this.handleWorkerMessage;
    this.worker.onerror = this.handleWorkerError;
    this.init(options.snapshot);
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: string,
    change?: DocumentSessionChange | null,
  ): void {
    if (this.disposed) return;
    if (this.shouldSkipDocumentUpdate(snapshot, kind)) {
      this.latestSnapshot = snapshot;
      return;
    }

    const previousSnapshot = this.latestSnapshot;
    const update = createPendingUpdate(snapshot, kind, change, previousSnapshot);
    this.latestSnapshot = snapshot;
    this.applyImmediateViewport(snapshot, snapshot.viewport.scrollTop);
    this.pendingUpdate = mergePendingUpdate(this.pendingUpdate, update);
    recordMinimapPerformanceDiagnostic("minimap.updateClassification", () =>
      pendingUpdateDiagnostics(update),
    );
    if (!this.renderInFlight) this.scheduleFlush();
  }

  public previewScrollTop(snapshot: EditorViewSnapshot, scrollTop: number): void {
    if (this.disposed) return;

    this.applyImmediateViewport(snapshot, scrollTop);
  }

  public setExternalDecorations(
    snapshot: EditorViewSnapshot,
    decorations: readonly EditorMinimapDecoration[],
  ): void {
    if (this.disposed) return;

    this.externalDecorations = decorations;
    this.update(snapshot, "decorations");
  }

  public dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.cancelScheduledFlush();
    this.post({ type: "dispose" });
    this.worker.terminate();
    this.colorResolver.dispose();
  }

  private init(snapshot: EditorViewSnapshot): void {
    const mainCanvas = this.host.mainCanvas.transferControlToOffscreen();
    const decorationsCanvas = this.host.decorationsCanvas.transferControlToOffscreen();
    const baseStyles = this.baseStyles();
    this.latestBaseStyles = baseStyles;
    this.latestBaseStylesSignature = baseStylesSignature(baseStyles);
    this.latestThemeSignature = themeSignature(snapshot);
    const request: MinimapWorkerRequest = {
      type: "init",
      options: this.options,
      baseStyles,
      mainCanvas,
      decorationsCanvas,
    };

    this.post(request, [mainCanvas, decorationsCanvas]);
    this.post({ type: "openDocument", document: this.documentPayload(snapshot) });
    this.latestFullDocumentSnapshot = snapshot;
    this.post({
      type: "updateLayout",
      metrics: this.metrics(snapshot),
      viewport: this.viewport(snapshot),
    });
    this.latestLayoutSignature = layoutSignature(snapshot);
    this.postRender(snapshot);
  }

  private scheduleFlush(): void {
    const pending = this.pendingUpdate;
    if (!pending) return;
    if (shouldDeferMinimapUpdate(pending)) {
      this.scheduleDeferredFlush();
      return;
    }

    this.scheduleFrameFlush();
  }

  private scheduleFrameFlush(): void {
    if (this.flushHandle !== 0) return;

    this.flushHandle = requestFrame(() => {
      this.flushHandle = 0;
      this.flushPendingUpdate();
    });
  }

  private scheduleDeferredFlush(): void {
    this.cancelScheduledFrame();
    this.cancelQuietFlush();
    this.quietFlushTimer = setTimeout(this.flushDeferredUpdate, MINIMAP_UPDATE_QUIET_DELAY_MS);
    if (this.maxFlushTimer === null) {
      this.maxFlushTimer = setTimeout(this.flushDeferredUpdate, MINIMAP_UPDATE_MAX_DELAY_MS);
    }
    this.scheduleIdleFlush();
  }

  private scheduleIdleFlush(): void {
    if (this.idleFlushHandle !== 0) return;
    if (typeof requestIdleCallback !== "function") return;

    this.idleFlushHandle = requestIdleCallback(
      () => {
        this.idleFlushHandle = 0;
        this.flushDeferredUpdate();
      },
      { timeout: MINIMAP_UPDATE_MAX_DELAY_MS },
    );
  }

  private flushDeferredUpdate = (): void => {
    this.cancelDeferredFlush();
    this.scheduleFrameFlush();
  };

  private flushPendingUpdate(): void {
    if (this.disposed) return;
    if (this.renderInFlight) return;

    const pending = this.pendingUpdate;
    if (!pending) return;

    measureMinimapPerformance(
      "minimap.flushPendingUpdate",
      () => this.flushPendingUpdateNow(pending),
      () => pendingUpdateDiagnostics(pending),
    );
  }

  private flushPendingUpdateNow(pending: PendingMinimapUpdate): void {
    this.pendingUpdate = null;
    measureMinimapPerformance(
      "minimap.postUpdate",
      () => this.postUpdate(pending),
      () => pendingUpdateDiagnostics(pending),
    );
    const layoutUpdated = this.postLayoutIfNeeded(pending.snapshot);
    this.postViewportIfNeeded(pending.snapshot, pending.syncViewport, layoutUpdated);
    this.postRender(pending.snapshot);
  }

  private postLayoutIfNeeded(snapshot: EditorViewSnapshot): boolean {
    const signature = layoutSignature(snapshot);
    if (signature === this.latestLayoutSignature) return false;

    this.latestLayoutSignature = signature;
    this.post({
      type: "updateLayout",
      metrics: this.metrics(snapshot),
      viewport: this.viewport(snapshot),
    });
    return true;
  }

  private postViewportIfNeeded(
    snapshot: EditorViewSnapshot,
    syncViewport: boolean,
    layoutUpdated: boolean,
  ): void {
    if (layoutUpdated) return;
    if (!syncViewport) return;

    this.post({ type: "updateViewport", viewport: this.viewport(snapshot) });
  }

  private postUpdate(update: PendingMinimapUpdate): void {
    const snapshot = update.snapshot;
    let tokenColorsInvalidated = false;
    if (update.syncBaseStyles) {
      tokenColorsInvalidated = this.refreshThemeColorCache(snapshot);
      tokenColorsInvalidated = this.syncBaseStyles() || tokenColorsInvalidated;
    }

    if (update.replaceDocument) {
      this.post({ type: "replaceDocument", document: this.documentPayload(snapshot) });
      this.latestFullDocumentSnapshot = snapshot;
      this.latestTokenSource = snapshot.tokens;
      return;
    }

    if (update.edits.length > 0) {
      this.latestFullDocumentSnapshot = null;
      this.postEditUpdate(update);
      this.latestTokenSource = update.tokenSourceAfterEdits;
    }
    if (update.syncTokens) {
      this.postTokenUpdate(snapshot, tokenColorsInvalidated);
    }
    if (update.syncSelection && update.edits.length === 0) {
      this.post({ type: "updateSelection", selections: selections(snapshot) });
    }
    if (update.syncExternalDecorations) {
      this.post({
        type: "updateExternalDecorations",
        decorations: this.externalDecorations,
      });
    }
  }

  private postEditUpdate(update: PendingMinimapUpdate): void {
    const document = this.documentEditPayload(update.snapshot);
    if (update.edits.length === 1) {
      this.post({ type: "applyEdit", edit: update.edits[0]!, document });
      return;
    }

    this.post({ type: "applyEdits", edits: update.edits, document });
  }

  private postTokenUpdate(snapshot: EditorViewSnapshot, forceFullUpdate: boolean): void {
    const sourceTokens = this.latestTokenSource;
    if (forceFullUpdate || !sourceTokens) {
      this.postFullTokenUpdate(snapshot);
      return;
    }

    const patch = this.tokenPatch(sourceTokens, snapshot.tokens);
    this.latestTokenSource = snapshot.tokens;
    if (patch.deleteCount === 0 && patch.tokens.length === 0) return;

    this.post({ type: "updateTokenRange", patch });
  }

  private postFullTokenUpdate(snapshot: EditorViewSnapshot): void {
    this.post({ type: "updateTokens", tokens: this.tokens(snapshot.tokens) });
    this.latestTokenSource = snapshot.tokens;
  }

  private tokenPatch(
    previous: readonly EditorToken[],
    next: readonly EditorToken[],
  ): MinimapTokenPatch {
    const range = changedTokenRange(previous, next);
    return {
      start: range.start,
      deleteCount: range.deleteCount,
      tokens: this.tokens(next.slice(range.start, range.insertEnd)),
    };
  }

  private syncBaseStyles(): boolean {
    const styles = this.baseStyles();
    const signature = baseStylesSignature(styles);
    if (signature === this.latestBaseStylesSignature) return false;

    this.latestBaseStyles = styles;
    this.latestBaseStylesSignature = signature;
    this.colorResolver.clear();
    this.post({ type: "updateBaseStyles", baseStyles: styles });
    return true;
  }

  private refreshThemeColorCache(snapshot: EditorViewSnapshot): boolean {
    const signature = themeSignature(snapshot);
    if (signature === this.latestThemeSignature) return false;

    this.latestThemeSignature = signature;
    this.colorResolver.clear();
    return true;
  }

  private shouldSkipDocumentUpdate(snapshot: EditorViewSnapshot, kind: string): boolean {
    if (kind !== "document") return false;
    const latest = this.latestFullDocumentSnapshot;
    if (!latest) return false;
    return latest === snapshot;
  }

  private postRender(snapshot: EditorViewSnapshot): void {
    this.sizeCanvasElements(snapshot);
    this.sequence += 1;
    this.renderInFlight = true;
    this.post({ type: "render", sequence: this.sequence });
  }

  private applyImmediateViewport(snapshot: EditorViewSnapshot, scrollTop: number): void {
    const slider = immediateSlider(
      snapshot,
      scrollTop,
      this.latestSliderHeight,
      this.latestSliderNeeded,
    );
    setStyleValue(this.host.slider, "display", slider.needed ? "block" : "none");
    setStyleValue(this.host.slider, "transform", `translate3d(0, ${slider.top}px, 0)`);
    setStyleValue(this.host.slider, "height", `${slider.height}px`);
    setStyleValue(this.host.sliderHorizontal, "height", `${slider.height}px`);
    setClassName(
      this.host.shadow,
      shadowVisible(snapshot)
        ? "editor-minimap-shadow editor-minimap-shadow-visible"
        : "editor-minimap-shadow editor-minimap-shadow-hidden",
    );
  }

  private documentPayload(snapshot: EditorViewSnapshot): MinimapDocumentPayload {
    let payload: MinimapDocumentPayload | null = null;
    return measureMinimapPerformance(
      "minimap.documentPayload",
      () => {
        payload = {
          text: snapshot.text,
          lineStarts: snapshot.lineStarts,
          tokens: this.tokens(snapshot.tokens),
          selections: selections(snapshot),
          decorations: this.externalDecorations,
          externalDecorations: this.externalDecorations,
        };
        return payload;
      },
      () => documentPayloadDiagnostics(payload),
    );
  }

  private documentEditPayload(snapshot: EditorViewSnapshot): MinimapDocumentEditPayload {
    let payload: MinimapDocumentEditPayload | null = null;
    return measureMinimapPerformance(
      "minimap.documentEditPayload",
      () => {
        payload = { selections: selections(snapshot) };
        return payload;
      },
      () => documentEditPayloadDiagnostics(payload),
    );
  }

  private tokens(tokens: readonly EditorToken[]): readonly MinimapToken[] {
    let projected: readonly MinimapToken[] | null = null;
    return measureMinimapPerformance(
      "minimap.tokens",
      () => {
        const foreground = this.latestBaseStyles?.foreground ?? this.baseStyles().foreground;
        projected = tokens.map((token) => ({
          start: token.start,
          end: token.end,
          color: this.colorResolver.resolve(token.style.color, foreground),
        }));
        return projected;
      },
      () => ({ inputTokens: tokens.length, outputTokens: projected?.length ?? 0 }),
    );
  }

  private metrics(snapshot: EditorViewSnapshot): MinimapMetrics {
    return {
      rowHeight: snapshot.metrics.rowHeight,
      characterWidth: snapshot.metrics.characterWidth,
      devicePixelRatio: globalThis.devicePixelRatio || 1,
    };
  }

  private viewport(snapshot: EditorViewSnapshot): MinimapViewport {
    return {
      scrollTop: snapshot.viewport.scrollTop,
      scrollLeft: snapshot.viewport.scrollLeft,
      scrollHeight: snapshot.viewport.scrollHeight,
      scrollWidth: snapshot.viewport.scrollWidth,
      clientHeight: snapshot.viewport.clientHeight,
      clientWidth: snapshot.viewport.clientWidth,
      visibleStart: snapshot.viewport.visibleRange.start,
      visibleEnd: snapshot.viewport.visibleRange.end,
    };
  }

  private baseStyles(): MinimapBaseStyles {
    const style = getComputedStyle(this.host.colorScope);
    const foreground = this.colorResolver.resolve(style.color, RGBA_WHITE);
    const background = this.colorResolver.resolve(style.backgroundColor, RGBA_BLACK);

    return {
      foreground,
      background,
      minimapBackground: transparent(
        this.colorResolver.resolve(
          style.getPropertyValue("--editor-minimap-background"),
          background,
        ),
        minimapBackgroundOpacity(style),
      ),
      foregroundOpacity: 255,
      selection: this.colorResolver.resolve(
        style.getPropertyValue("--editor-minimap-selection-highlight"),
        { r: 56, g: 189, b: 248, a: 128 },
      ),
      slider:
        style.getPropertyValue("--editor-minimap-slider-background") || "rgba(121,121,121,.2)",
      sliderHover:
        style.getPropertyValue("--editor-minimap-slider-hover-background") ||
        "rgba(121,121,121,.35)",
      sliderActive:
        style.getPropertyValue("--editor-minimap-slider-active-background") ||
        "rgba(121,121,121,.5)",
      fontFamily: style.fontFamily || "monospace",
    };
  }

  private sizeCanvasElements(snapshot: EditorViewSnapshot): void {
    const height = `${Math.max(0, snapshot.viewport.clientHeight)}px`;
    setStyleValue(this.host.mainCanvas, "height", height);
    setStyleValue(this.host.decorationsCanvas, "height", height);
  }

  private handleWorkerMessage = (event: MessageEvent<MinimapWorkerResponse>): void => {
    const response = event.data;
    if (response.type === "layout") {
      this.applyLayout(
        response.layout.width,
        response.layout.canvasOuterWidth,
        response.layout.canvasOuterHeight,
      );
      return;
    }
    if (response.type === "rendered") {
      this.renderInFlight = false;
      if (this.pendingUpdate) {
        this.scheduleFlush();
        return;
      }

      this.applyRenderedResponse(response);
      return;
    }
    if (response.type === "error") console.warn(response.message);
  };

  private applyLayout(width: number, canvasWidth: number, canvasHeight: number): void {
    this.onLayoutWidth(width);
    setStyleValue(this.host.root, "width", `${width}px`);
    setStyleValue(this.host.mainCanvas, "width", `${canvasWidth}px`);
    setStyleValue(this.host.decorationsCanvas, "width", `${canvasWidth}px`);
    setStyleValue(this.host.mainCanvas, "height", `${canvasHeight}px`);
    setStyleValue(this.host.decorationsCanvas, "height", `${canvasHeight}px`);
  }

  private applyRenderedResponse(
    response: Extract<MinimapWorkerResponse, { type: "rendered" }>,
  ): void {
    if (response.sequence < this.latestRenderedSequence) return;

    this.latestRenderedSequence = response.sequence;
    this.latestSliderHeight = response.sliderHeight;
    this.latestSliderNeeded = response.sliderNeeded;
    setStyleValue(this.host.slider, "display", response.sliderNeeded ? "block" : "none");
    setStyleValue(this.host.slider, "transform", `translate3d(0, ${response.sliderTop}px, 0)`);
    setStyleValue(this.host.slider, "height", `${response.sliderHeight}px`);
    setStyleValue(this.host.sliderHorizontal, "height", `${response.sliderHeight}px`);
    setClassName(
      this.host.shadow,
      response.shadowVisible
        ? "editor-minimap-shadow editor-minimap-shadow-visible"
        : "editor-minimap-shadow editor-minimap-shadow-hidden",
    );
  }

  private handleWorkerError = (event: ErrorEvent): void => {
    console.warn(event.message || "Minimap worker failed");
  };

  private post(request: MinimapWorkerRequest, transfer?: readonly Transferable[]): void {
    measureMinimapPerformance(
      "minimap.post",
      () => {
        if (transfer) {
          this.worker.postMessage(request, [...transfer]);
          return;
        }

        this.worker.postMessage(request);
      },
      () => requestDiagnostics(request),
    );
  }

  private cancelScheduledFlush(): void {
    this.cancelScheduledFrame();
    this.cancelDeferredFlush();
  }

  private cancelScheduledFrame(): void {
    if (this.flushHandle === 0) return;

    cancelFrame(this.flushHandle);
    this.flushHandle = 0;
  }

  private cancelDeferredFlush(): void {
    this.cancelQuietFlush();
    this.cancelMaxFlush();
    this.cancelIdleFlush();
  }

  private cancelQuietFlush(): void {
    if (this.quietFlushTimer === null) return;

    clearTimeout(this.quietFlushTimer);
    this.quietFlushTimer = null;
  }

  private cancelMaxFlush(): void {
    if (this.maxFlushTimer === null) return;

    clearTimeout(this.maxFlushTimer);
    this.maxFlushTimer = null;
  }

  private cancelIdleFlush(): void {
    if (this.idleFlushHandle === 0) return;
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(this.idleFlushHandle);
    this.idleFlushHandle = 0;
  }
}

type PendingMinimapUpdate = {
  readonly snapshot: EditorViewSnapshot;
  readonly replaceDocument: boolean;
  readonly edits: readonly TextEdit[];
  readonly syncTokens: boolean;
  readonly syncSelection: boolean;
  readonly syncExternalDecorations: boolean;
  readonly syncViewport: boolean;
  readonly syncBaseStyles: boolean;
  readonly tokenSourceAfterEdits: readonly EditorToken[] | null;
  readonly reason: string;
};

export function canUseMinimapWorker(): boolean {
  if (typeof Worker === "undefined") return false;
  if (typeof OffscreenCanvas === "undefined") return false;
  return (
    typeof HTMLCanvasElement !== "undefined" &&
    "transferControlToOffscreen" in HTMLCanvasElement.prototype
  );
}

function selections(snapshot: EditorViewSnapshot): readonly MinimapSelection[] {
  return snapshot.selections.map((selection) => ({
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
  }));
}

function incrementalTextEdits(
  change: DocumentSessionChange | null | undefined,
): readonly TextEdit[] | null {
  if (!change || change.edits.length === 0) return null;

  const sorted = change.edits.toSorted(compareTextEdits);
  return sequentialTextEdits(sorted);
}

function immediateSlider(
  snapshot: EditorViewSnapshot,
  scrollTop: number,
  sliderHeight: number,
  sliderNeeded: boolean,
): {
  readonly needed: boolean;
  readonly top: number;
  readonly height: number;
} {
  const viewport = snapshot.viewport;
  const scrollable = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const trackHeight = Math.max(1, viewport.clientHeight);
  const height = Math.max(0, sliderHeight);
  const maxTop = Math.max(0, trackHeight - height);
  const top = scrollable > 0 ? (clamp(scrollTop, 0, scrollable) / scrollable) * maxTop : 0;

  return { needed: sliderNeeded && maxTop > 0, top, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function shadowVisible(snapshot: EditorViewSnapshot): boolean {
  const viewport = snapshot.viewport;
  return viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth;
}

function baseStylesSignature(styles: MinimapBaseStyles): string {
  return JSON.stringify(styles);
}

function layoutSignature(snapshot: EditorViewSnapshot): string {
  return [
    snapshot.metrics.rowHeight,
    snapshot.metrics.characterWidth,
    globalThis.devicePixelRatio || 1,
    snapshot.viewport.clientHeight,
    snapshot.viewport.clientWidth,
    snapshot.lineCount,
  ].join(":");
}

function createPendingUpdate(
  snapshot: EditorViewSnapshot,
  kind: string,
  change: DocumentSessionChange | null | undefined,
  previousSnapshot: EditorViewSnapshot,
): PendingMinimapUpdate {
  const base = basePendingUpdate(snapshot, kind);
  if (kind === "content") return contentPendingUpdate(base, change, previousSnapshot);
  if (kind === "document" || kind === "clear") {
    return { ...base, replaceDocument: true, reason: kind };
  }
  if (kind === "tokens") return { ...base, syncTokens: true, reason: "tokens" };
  if (kind === "selection") return { ...base, syncSelection: true, reason: "selection" };
  if (kind === "decorations") {
    return { ...base, syncExternalDecorations: true, reason: "decorations" };
  }

  return { ...base, reason: kind };
}

function mergePendingUpdate(
  current: PendingMinimapUpdate | null,
  next: PendingMinimapUpdate,
): PendingMinimapUpdate {
  if (!current) return next;
  if (current.replaceDocument || next.replaceDocument) return mergeReplacementUpdate(current, next);

  const edits = [...current.edits, ...next.edits];
  const contentChangedAfterTokens = next.edits.length > 0;
  return {
    snapshot: next.snapshot,
    replaceDocument: false,
    edits,
    syncTokens: contentChangedAfterTokens ? next.syncTokens : current.syncTokens || next.syncTokens,
    syncSelection: current.syncSelection || next.syncSelection,
    syncExternalDecorations: current.syncExternalDecorations || next.syncExternalDecorations,
    syncViewport: current.syncViewport || next.syncViewport,
    syncBaseStyles: current.syncBaseStyles || next.syncBaseStyles,
    tokenSourceAfterEdits: mergedTokenSourceAfterEdits(current, next),
    reason: mergeReasons(current.reason, next.reason),
  };
}

function mergeReplacementUpdate(
  current: PendingMinimapUpdate,
  next: PendingMinimapUpdate,
): PendingMinimapUpdate {
  return {
    snapshot: next.snapshot,
    replaceDocument: true,
    edits: [],
    syncTokens: false,
    syncSelection: false,
    syncExternalDecorations: false,
    syncViewport: current.syncViewport || next.syncViewport,
    syncBaseStyles: current.syncBaseStyles || next.syncBaseStyles,
    tokenSourceAfterEdits: null,
    reason: mergeReasons(current.reason, next.reason),
  };
}

function mergedTokenSourceAfterEdits(
  current: PendingMinimapUpdate,
  next: PendingMinimapUpdate,
): readonly EditorToken[] | null {
  if (next.edits.length === 0) return current.tokenSourceAfterEdits;
  if (current.syncTokens) return null;
  return next.tokenSourceAfterEdits;
}

function shouldSyncBaseStyles(kind: string): boolean {
  if (kind === "tokens") return true;
  if (kind === "document") return true;
  return kind === "clear";
}

function basePendingUpdate(snapshot: EditorViewSnapshot, kind: string): PendingMinimapUpdate {
  return {
    snapshot,
    replaceDocument: false,
    edits: [],
    syncTokens: false,
    syncSelection: false,
    syncExternalDecorations: false,
    syncViewport: shouldSyncViewport(kind),
    syncBaseStyles: shouldSyncBaseStyles(kind),
    tokenSourceAfterEdits: null,
    reason: "metadata",
  };
}

function contentPendingUpdate(
  base: PendingMinimapUpdate,
  change: DocumentSessionChange | null | undefined,
  previousSnapshot: EditorViewSnapshot,
): PendingMinimapUpdate {
  const edits = incrementalTextEdits(change);
  if (!edits) {
    return { ...base, replaceDocument: true, reason: "content.replaceDocument" };
  }

  return {
    ...base,
    edits,
    syncSelection: true,
    tokenSourceAfterEdits: tokenSourceAfterEdits(change, previousSnapshot, base.snapshot),
    reason: edits.length === 1 ? "content.edit" : "content.edits",
  };
}

function shouldSyncViewport(kind: string): boolean {
  if (kind === "content") return true;
  if (kind === "document") return true;
  if (kind === "clear") return true;
  if (kind === "viewport") return true;
  return kind === "layout";
}

function shouldDeferMinimapUpdate(update: PendingMinimapUpdate): boolean {
  if (update.reason.includes("content")) return true;
  if (update.syncTokens) return true;
  return update.syncExternalDecorations;
}

function sequentialTextEdits(edits: readonly TextEdit[]): readonly TextEdit[] {
  let delta = 0;
  return edits.map((edit) => {
    const from = edit.from + delta;
    const to = edit.to + delta;
    delta += edit.text.length - (edit.to - edit.from);
    return { from, to, text: edit.text };
  });
}

function compareTextEdits(left: TextEdit, right: TextEdit): number {
  return left.from - right.from || left.to - right.to;
}

function tokenSourceAfterEdits(
  change: DocumentSessionChange | null | undefined,
  previousSnapshot: EditorViewSnapshot,
  nextSnapshot: EditorViewSnapshot,
): readonly EditorToken[] | null {
  if (!change) return null;
  if (!editsPreserveLineStructure(change.edits, previousSnapshot.lineStarts)) return null;
  return nextSnapshot.tokens;
}

function editsPreserveLineStructure(
  edits: readonly TextEdit[],
  lineStarts: readonly number[],
): boolean {
  for (const edit of edits) {
    if (edit.text.includes("\n")) return false;
    if (!editRangeIsSingleLine(lineStarts, edit)) return false;
  }

  return true;
}

function editRangeIsSingleLine(lineStarts: readonly number[], edit: TextEdit): boolean {
  return lineIndexForOffset(lineStarts, edit.from) === lineIndexForOffset(lineStarts, edit.to);
}

function lineIndexForOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  const clamped = Math.max(0, offset);

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = lineStarts[middle] ?? 0;
    const next = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (clamped < start) {
      high = middle - 1;
      continue;
    }
    if (clamped >= next) {
      low = middle + 1;
      continue;
    }
    return middle;
  }

  return Math.max(0, lineStarts.length - 1);
}

function changedTokenRange(
  previous: readonly EditorToken[],
  next: readonly EditorToken[],
): {
  readonly start: number;
  readonly deleteCount: number;
  readonly insertEnd: number;
} {
  let start = 0;
  while (
    start < previous.length &&
    start < next.length &&
    editorTokensEqual(previous[start]!, next[start]!)
  ) {
    start += 1;
  }

  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    editorTokensEqual(previous[previousEnd - 1]!, next[nextEnd - 1]!)
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    deleteCount: previousEnd - start,
    insertEnd: nextEnd,
  };
}

function editorTokensEqual(left: EditorToken, right: EditorToken): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    tokenStylesEqual(left.style, right.style)
  );
}

function tokenStylesEqual(left: EditorToken["style"], right: EditorToken["style"]): boolean {
  return (
    left.color === right.color &&
    left.backgroundColor === right.backgroundColor &&
    left.fontStyle === right.fontStyle &&
    left.fontWeight === right.fontWeight &&
    left.textDecoration === right.textDecoration
  );
}

function mergeReasons(left: string, right: string): string {
  if (left === right) return left;
  return `${left}+${right}`;
}

type MinimapPerformanceDiagnostic = {
  readonly name: string;
  readonly durationMs?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
};

type MinimapPerformanceDiagnosticSink =
  | ((diagnostic: MinimapPerformanceDiagnostic) => void)
  | {
      readonly enabled?: boolean;
      readonly record?: (diagnostic: MinimapPerformanceDiagnostic) => void;
    };

type MinimapPerformanceDiagnosticGlobal = typeof globalThis & {
  __EDITOR_PERFORMANCE_DIAGNOSTICS__?: MinimapPerformanceDiagnosticSink | null;
};

type DiagnosticDetail =
  | Readonly<Record<string, unknown>>
  | (() => Readonly<Record<string, unknown>> | undefined)
  | undefined;

function measureMinimapPerformance<T>(name: string, run: () => T, detail?: DiagnosticDetail): T {
  if (!minimapPerformanceDiagnosticsEnabled()) return run();

  const start = nowMs();
  try {
    return run();
  } finally {
    recordMinimapPerformanceDiagnostic(name, detail, nowMs() - start);
  }
}

function recordMinimapPerformanceDiagnostic(
  name: string,
  detail?: DiagnosticDetail,
  durationMs?: number,
): void {
  const sink = minimapPerformanceDiagnosticSink();
  if (!sink) return;

  const diagnostic = createDiagnostic(name, detail, durationMs);
  if (typeof sink === "function") {
    sink(diagnostic);
    return;
  }

  sink.record?.(diagnostic);
}

function minimapPerformanceDiagnosticsEnabled(): boolean {
  const sink = minimapPerformanceDiagnosticGlobal().__EDITOR_PERFORMANCE_DIAGNOSTICS__;
  if (!sink) return false;
  if (typeof sink === "function") return true;
  return sink.enabled === true || typeof sink.record === "function";
}

function minimapPerformanceDiagnosticSink(): MinimapPerformanceDiagnosticSink | null {
  const sink = minimapPerformanceDiagnosticGlobal().__EDITOR_PERFORMANCE_DIAGNOSTICS__;
  if (!sink) return null;
  if (typeof sink === "function") return sink;
  if (sink.enabled !== true && typeof sink.record !== "function") return null;
  return sink;
}

function createDiagnostic(
  name: string,
  detail: DiagnosticDetail,
  durationMs: number | undefined,
): MinimapPerformanceDiagnostic {
  const resolvedDetail = resolveDiagnosticDetail(detail);
  if (durationMs === undefined && resolvedDetail === undefined) return { name };
  if (durationMs === undefined) return { name, detail: resolvedDetail };
  if (resolvedDetail === undefined) return { name, durationMs };
  return { name, durationMs, detail: resolvedDetail };
}

function resolveDiagnosticDetail(
  detail: DiagnosticDetail,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof detail === "function") return detail();
  return detail;
}

function minimapPerformanceDiagnosticGlobal(): MinimapPerformanceDiagnosticGlobal {
  return globalThis as MinimapPerformanceDiagnosticGlobal;
}

function pendingUpdateDiagnostics(update: PendingMinimapUpdate): Readonly<Record<string, unknown>> {
  return {
    editCount: update.edits.length,
    incremental: !update.replaceDocument,
    reason: update.reason,
    syncBaseStyles: update.syncBaseStyles,
    syncExternalDecorations: update.syncExternalDecorations,
    syncSelection: update.syncSelection,
    syncTokens: update.syncTokens,
    syncViewport: update.syncViewport,
    tokenSourceKnown: update.tokenSourceAfterEdits !== null || update.edits.length === 0,
    type: update.replaceDocument ? "replaceDocument" : "incremental",
  };
}

function requestDiagnostics(request: MinimapWorkerRequest): Readonly<Record<string, unknown>> {
  switch (request.type) {
    case "openDocument":
    case "replaceDocument":
      return { request: request.type, ...documentPayloadDiagnostics(request.document) };
    case "applyEdit":
      return {
        request: request.type,
        editTextLength: request.edit.text.length,
        ...documentEditPayloadDiagnostics(request.document),
      };
    case "applyEdits":
      return {
        request: request.type,
        editCount: request.edits.length,
        editTextLength: textLengthForEdits(request.edits),
        ...documentEditPayloadDiagnostics(request.document),
      };
    case "updateTokens":
      return { request: request.type, tokens: request.tokens.length };
    case "updateTokenRange":
      return {
        request: request.type,
        deleteCount: request.patch.deleteCount,
        start: request.patch.start,
        tokens: request.patch.tokens.length,
      };
    case "updateSelection":
      return { request: request.type, selections: request.selections.length };
    case "updateDecorations":
    case "updateExternalDecorations":
      return { request: request.type, decorations: request.decorations.length };
    default:
      return { request: "control" };
  }
}

function documentPayloadDiagnostics(
  payload: MinimapDocumentPayload | null,
): Readonly<Record<string, unknown>> {
  return {
    decorations: payload?.decorations.length ?? 0,
    externalDecorations: payload?.externalDecorations?.length ?? 0,
    lineStarts: payload?.lineStarts.length ?? 0,
    selections: payload?.selections.length ?? 0,
    textLength: payload?.text.length ?? 0,
    tokens: payload?.tokens.length ?? 0,
    type: "document",
  };
}

function documentEditPayloadDiagnostics(
  payload: MinimapDocumentEditPayload | null,
): Readonly<Record<string, unknown>> {
  return {
    selections: payload?.selections.length ?? 0,
    type: "edit",
  };
}

function textLengthForEdits(edits: readonly TextEdit[]): number {
  let length = 0;
  for (const edit of edits) length += edit.text.length;
  return length;
}

function setStyleValue(
  element: HTMLElement,
  property: "display" | "height" | "transform" | "width",
  value: string,
): void {
  if (element.style[property] === value) return;

  element.style[property] = value;
}

function setClassName(element: HTMLElement, className: string): void {
  if (element.className === className) return;

  element.className = className;
}

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }

  clearTimeout(handle);
}

function minimapBackgroundOpacity(style: CSSStyleDeclaration): number {
  const value = Number.parseFloat(style.getPropertyValue("--editor-minimap-background-opacity"));
  if (!Number.isFinite(value)) return 1;

  return Math.min(1, Math.max(0, value));
}

function themeSignature(snapshot: EditorViewSnapshot): string {
  return JSON.stringify(snapshot.theme ?? null);
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

class ColorResolver {
  private readonly probe: HTMLSpanElement;
  private readonly canvasContext: CanvasRenderingContext2D | null;
  private readonly cache = new Map<string, RGBA8>();

  public constructor(root: HTMLElement) {
    this.probe = root.ownerDocument.createElement("span");
    this.canvasContext = root.ownerDocument.createElement("canvas").getContext("2d", {
      willReadFrequently: true,
    });
    this.probe.style.position = "absolute";
    this.probe.style.visibility = "hidden";
    this.probe.textContent = ".";
    root.appendChild(this.probe);
  }

  public resolve(value: string | undefined, fallback: RGBA8): RGBA8 {
    if (!value) return fallback;
    const cached = this.cache.get(value);
    if (cached) return cached;

    this.probe.style.color = value;
    const resolved = this.resolveComputedColor(getComputedStyle(this.probe).color, fallback);
    this.cache.set(value, resolved);
    return resolved;
  }

  public clear(): void {
    this.cache.clear();
  }

  public dispose(): void {
    this.clear();
    this.probe.remove();
  }

  private resolveComputedColor(value: string, fallback: RGBA8): RGBA8 {
    const canvasColor = this.canvasColor(value);
    if (canvasColor) return canvasColor;

    return parseCssColor(value, fallback);
  }

  private canvasColor(value: string): RGBA8 | null {
    const context = this.canvasContext;
    if (!context) return null;

    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);

    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a ?? 0 };
  }
}
