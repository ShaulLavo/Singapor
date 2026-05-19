import type {
  DocumentSessionChange,
  EditorMinimapDecoration,
  EditorToken,
  EditorViewSnapshot,
  TextEdit,
} from "@editor/core";
import { parseCssColor, RGBA_BLACK, RGBA_WHITE, transparent } from "./color";
import { findSectionHeaderDecorations } from "./sectionHeaders";
import type {
  MinimapBaseStyles,
  MinimapDocumentEditPayload,
  MinimapDocumentPayload,
  MinimapMetrics,
  MinimapSelection,
  MinimapToken,
  MinimapViewport,
  MinimapWorkerRequest,
  MinimapWorkerResponse,
  ResolvedMinimapOptions,
  RGBA8,
} from "./types";

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
  private renderInFlight = false;
  private latestSliderHeight = 0;
  private latestSliderNeeded = false;
  private latestBaseStyles: MinimapBaseStyles | null = null;
  private latestBaseStylesSignature = "";
  private latestLayoutSignature = "";
  private latestThemeSignature = "";
  private disposed = false;

  public constructor(options: MinimapWorkerClientOptions) {
    this.host = options.host;
    this.options = options.options;
    this.onLayoutWidth = options.onLayoutWidth;
    this.externalDecorations = options.decorations;
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
    this.applyImmediateViewport(snapshot, snapshot.viewport.scrollTop);
    this.pendingUpdate = mergePendingUpdate(this.pendingUpdate, { snapshot, kind, change });
    this.scheduleFlush();
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

    this.worker.postMessage(request, [mainCanvas, decorationsCanvas]);
    this.post({ type: "openDocument", document: this.documentPayload(snapshot) });
    this.post({
      type: "updateLayout",
      metrics: this.metrics(snapshot),
      viewport: this.viewport(snapshot),
    });
    this.latestLayoutSignature = layoutSignature(snapshot);
    this.postRender(snapshot);
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== 0) return;

    this.flushHandle = requestFrame(() => {
      this.flushHandle = 0;
      this.flushPendingUpdate();
    });
  }

  private flushPendingUpdate(): void {
    if (this.disposed) return;
    if (this.renderInFlight) return;

    const pending = this.pendingUpdate;
    if (!pending) return;

    this.pendingUpdate = null;
    this.postUpdate(pending.snapshot, pending.kind, pending.change);
    const layoutUpdated = this.postLayoutIfNeeded(pending.snapshot);
    this.postViewportIfNeeded(pending.snapshot, pending.kind, layoutUpdated);
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
    kind: string,
    layoutUpdated: boolean,
  ): void {
    if (layoutUpdated) return;
    if (!shouldSyncViewportAfterUpdate(kind)) return;

    this.post({ type: "updateViewport", viewport: this.viewport(snapshot) });
  }

  private postUpdate(
    snapshot: EditorViewSnapshot,
    kind: string,
    change: DocumentSessionChange | null | undefined,
  ): void {
    if (shouldSyncBaseStyles(kind)) {
      this.refreshThemeColorCache(snapshot);
      this.syncBaseStyles();
    }

    if (kind === "tokens") {
      this.post({ type: "updateTokens", tokens: this.tokens(snapshot.tokens) });
      return;
    }
    if (kind === "selection") {
      this.post({ type: "updateSelection", selections: selections(snapshot) });
      return;
    }
    if (kind === "decorations") {
      this.post({ type: "updateDecorations", decorations: this.decorations(snapshot) });
      return;
    }
    if (kind === "viewport" || kind === "layout") {
      this.post({ type: "updateViewport", viewport: this.viewport(snapshot) });
      return;
    }
    if (singleLineEdit(change)) {
      this.post({
        type: "applyEdit",
        edit: change.edits[0]!,
        document: this.documentEditPayload(snapshot),
      });
      return;
    }

    this.post({ type: "replaceDocument", document: this.documentPayload(snapshot) });
  }

  private syncBaseStyles(): void {
    const styles = this.baseStyles();
    const signature = baseStylesSignature(styles);
    if (signature === this.latestBaseStylesSignature) return;

    this.latestBaseStyles = styles;
    this.latestBaseStylesSignature = signature;
    this.colorResolver.clear();
    this.post({ type: "updateBaseStyles", baseStyles: styles });
  }

  private refreshThemeColorCache(snapshot: EditorViewSnapshot): void {
    const signature = themeSignature(snapshot);
    if (signature === this.latestThemeSignature) return;

    this.latestThemeSignature = signature;
    this.colorResolver.clear();
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
    return {
      text: snapshot.text,
      lineStarts: snapshot.lineStarts,
      tokens: this.tokens(snapshot.tokens),
      selections: selections(snapshot),
      decorations: this.decorations(snapshot),
    };
  }

  private documentEditPayload(snapshot: EditorViewSnapshot): MinimapDocumentEditPayload {
    return {
      lineStarts: snapshot.lineStarts,
      selections: selections(snapshot),
      externalDecorations: this.externalDecorations,
    };
  }

  private decorations(snapshot: EditorViewSnapshot): readonly EditorMinimapDecoration[] {
    const lines = splitLines(snapshot.text);
    const sectionHeaders = findSectionHeaderDecorations(lines, this.options);
    return [...sectionHeaders, ...this.externalDecorations];
  }

  private tokens(tokens: readonly EditorToken[]): readonly MinimapToken[] {
    const foreground = this.latestBaseStyles?.foreground ?? this.baseStyles().foreground;
    return tokens.map((token) => ({
      start: token.start,
      end: token.end,
      color: this.colorResolver.resolve(token.style.color, foreground),
    }));
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
      this.applyRenderedResponse(response);
      this.renderInFlight = false;
      if (this.pendingUpdate) this.scheduleFlush();
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

  private post(request: MinimapWorkerRequest): void {
    this.worker.postMessage(request);
  }

  private cancelScheduledFlush(): void {
    if (this.flushHandle === 0) return;

    cancelFrame(this.flushHandle);
    this.flushHandle = 0;
  }
}

type PendingMinimapUpdate = {
  readonly snapshot: EditorViewSnapshot;
  readonly kind: string;
  readonly change?: DocumentSessionChange | null;
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

function singleLineEdit(
  change: DocumentSessionChange | null | undefined,
): change is DocumentSessionChange & {
  readonly edits: readonly [TextEdit];
} {
  if (!change || change.kind !== "edit" || change.edits.length !== 1) return false;
  const edit = change.edits[0]!;
  if (edit.text.includes("\n")) return false;
  return edit.from === edit.to;
}

function splitLines(text: string): readonly string[] {
  return text.split("\n");
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

function shouldSyncViewportAfterUpdate(kind: string): boolean {
  if (kind === "content") return true;
  if (kind === "document") return true;
  return kind === "clear";
}

function mergePendingUpdate(
  current: PendingMinimapUpdate | null,
  next: PendingMinimapUpdate,
): PendingMinimapUpdate {
  if (!current) return next;
  if (canUseLatestKind(current.kind, next.kind)) return next;

  return {
    snapshot: next.snapshot,
    kind: "content",
    change: next.change ?? null,
  };
}

function canUseLatestKind(currentKind: string, nextKind: string): boolean {
  if (currentKind === nextKind) return true;
  if (isViewportOnly(currentKind) && isViewportOnly(nextKind)) return true;
  return false;
}

function isViewportOnly(kind: string): boolean {
  return kind === "viewport" || kind === "layout";
}

function shouldSyncBaseStyles(kind: string): boolean {
  if (kind === "tokens") return true;
  if (kind === "document") return true;
  return kind === "clear";
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
