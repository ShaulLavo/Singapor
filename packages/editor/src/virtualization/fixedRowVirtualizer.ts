import {
  createRowHeightIndex,
  rowHeightIndexRowAfterOffset,
  rowHeightIndexRowAtOffset,
  rowHeightIndexStart,
  type RowHeightIndex,
} from "./rowHeightIndex";

export type FixedRowVisibleRange = {
  readonly start: number;
  readonly end: number;
};

export type FixedRowVirtualItem = {
  readonly index: number;
  readonly start: number;
  readonly size: number;
};

export type FixedRowVirtualizerSnapshot = {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly borderBoxWidth: number;
  readonly borderBoxHeight: number;
  readonly totalSize: number;
  readonly visibleRange: FixedRowVisibleRange;
  readonly virtualItems: readonly FixedRowVirtualItem[];
};

export type FixedRowVirtualizerOptions = {
  readonly count: number;
  readonly rowHeight: number;
  readonly rowGap?: number;
  readonly rowSizes?: readonly number[];
  readonly overscan?: number;
  readonly enabled?: boolean;
};

export type FixedRowScrollMetrics = {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly borderBoxHeight?: number;
  readonly borderBoxWidth?: number;
  readonly scrollLeft?: number;
  readonly viewportWidth?: number;
};

export type FixedRowVirtualizerChangeHandler = (snapshot: FixedRowVirtualizerSnapshot) => void;

export type FixedRowVirtualizerAttachOptions = {
  readonly readInitialScrollPosition?: boolean;
};

type AttachedScrollElement = {
  readonly element: HTMLElement;
  readonly onScroll: () => void;
  readonly resizeObserver: ResizeObserver | null;
};

const DEFAULT_ROW_HEIGHT = 1;
const DEFAULT_ROW_GAP = 0;

export function computeFixedRowTotalSize(
  count: number,
  rowHeight: number,
  rowGap?: number,
): number {
  const normalizedCount = normalizeCount(count);
  const normalizedRowHeight = normalizeRowHeight(rowHeight);
  const normalizedRowGap = normalizeRowGap(rowGap);
  return normalizedCount * normalizedRowHeight + totalRowGap(normalizedCount, normalizedRowGap);
}

export function computeFixedRowVisibleRange(options: {
  readonly count: number;
  readonly rowHeight: number;
  readonly rowGap?: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly enabled?: boolean;
}): FixedRowVisibleRange {
  const count = normalizeCount(options.count);
  if (options.enabled === false || count === 0) return { start: 0, end: 0 };

  const rowHeight = normalizeRowHeight(options.rowHeight);
  const rowGap = normalizeRowGap(options.rowGap);
  const scrollTop = Math.max(0, normalizeNumber(options.scrollTop));
  const viewportHeight = Math.max(0, normalizeNumber(options.viewportHeight));
  const start = fixedRowIndexAtOffset(count, rowHeight, rowGap, scrollTop);
  const rawEnd = fixedRowIndexAfterOffset(count, rowHeight, rowGap, scrollTop + viewportHeight);
  const end = clamp(Math.max(start + 1, rawEnd), start + 1, count);
  return { start, end };
}

export function computeFixedRowVirtualItems(options: {
  readonly count: number;
  readonly rowHeight: number;
  readonly rowGap?: number;
  readonly range: FixedRowVisibleRange;
  readonly overscan?: number;
  readonly enabled?: boolean;
}): FixedRowVirtualItem[] {
  const count = normalizeCount(options.count);
  if (options.enabled === false || count === 0) return [];

  const rowHeight = normalizeRowHeight(options.rowHeight);
  const rowGap = normalizeRowGap(options.rowGap);
  const window = computeOverscannedRange(count, options.range, options.overscan);
  const items: FixedRowVirtualItem[] = [];

  for (let index = window.start; index < window.end; index += 1) {
    items.push(createVirtualItem(index, rowHeight, rowGap));
  }

  return items;
}

export class FixedRowVirtualizer {
  private options: NormalizedFixedRowVirtualizerOptions;
  private scrollTop = 0;
  private scrollLeft = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private borderBoxWidth = 0;
  private borderBoxHeight = 0;
  private attached: AttachedScrollElement | null = null;
  private changeHandler: FixedRowVirtualizerChangeHandler | null = null;
  private scrollAnimationFrame = 0;
  private itemCache = new Map<number, FixedRowVirtualItem>();
  private cachedRowHeight = DEFAULT_ROW_HEIGHT;
  private cachedRowGap = DEFAULT_ROW_GAP;

  public constructor(options: FixedRowVirtualizerOptions) {
    this.options = normalizeOptions(options);
    this.cachedRowHeight = this.options.rowHeight;
    this.cachedRowGap = this.options.rowGap;
  }

  public updateOptions(options: Partial<FixedRowVirtualizerOptions>): void {
    const next = normalizeOptions({ ...denormalizeOptions(this.options), ...options });
    this.updateCacheForFixedRows(next.rowHeight, next.rowGap);
    this.options = next;
    this.emitChange();
  }

  public attachScrollElement(
    element: HTMLElement,
    onChange?: FixedRowVirtualizerChangeHandler,
    options: FixedRowVirtualizerAttachOptions = {},
  ): void {
    this.detachScrollElement();
    this.changeHandler = onChange ?? null;

    const onScroll = (): void => this.scheduleScrollSync();
    const resizeObserver = createResizeObserver((entries) => this.syncFromResizeEntries(entries));
    this.attached = { element, onScroll, resizeObserver };

    element.addEventListener("scroll", onScroll, { passive: true });
    resizeObserver?.observe(element);
    if (options.readInitialScrollPosition !== false) {
      this.syncScrollPositionFromElement();
    }
  }

  public detachScrollElement(): void {
    const attached = this.attached;
    if (!attached) return;

    attached.element.removeEventListener("scroll", attached.onScroll);
    attached.resizeObserver?.disconnect();
    this.cancelScheduledScrollSync();
    this.attached = null;
  }

  public dispose(): void {
    this.detachScrollElement();
    this.changeHandler = null;
    this.itemCache.clear();
  }

  public setScrollMetrics(metrics: FixedRowScrollMetrics): void {
    const nextScrollTop = Math.max(0, normalizeNumber(metrics.scrollTop));
    const nextViewportHeight = Math.max(0, normalizeNumber(metrics.viewportHeight));
    const nextScrollLeft = optionalNonNegative(metrics.scrollLeft, this.scrollLeft);
    const nextViewportWidth = optionalNonNegative(metrics.viewportWidth, this.viewportWidth);
    const nextBorderBoxWidth = optionalBorderBoxMetric(
      metrics.borderBoxWidth,
      this.borderBoxWidth,
      nextViewportWidth,
      metrics.viewportWidth,
    );
    const nextBorderBoxHeight = optionalBorderBoxMetric(
      metrics.borderBoxHeight,
      this.borderBoxHeight,
      nextViewportHeight,
      metrics.viewportHeight,
    );
    if (
      nextScrollTop === this.scrollTop &&
      nextScrollLeft === this.scrollLeft &&
      nextViewportWidth === this.viewportWidth &&
      nextViewportHeight === this.viewportHeight &&
      nextBorderBoxWidth === this.borderBoxWidth &&
      nextBorderBoxHeight === this.borderBoxHeight
    )
      return;

    this.scrollTop = nextScrollTop;
    this.scrollLeft = nextScrollLeft;
    this.viewportWidth = nextViewportWidth;
    this.viewportHeight = nextViewportHeight;
    this.borderBoxWidth = nextBorderBoxWidth;
    this.borderBoxHeight = nextBorderBoxHeight;
    this.emitChange();
  }

  public getSnapshot(): FixedRowVirtualizerSnapshot {
    const visibleRange = this.getVisibleRange();
    return {
      scrollTop: this.scrollTop,
      scrollLeft: this.scrollLeft,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      borderBoxWidth: this.borderBoxWidth,
      borderBoxHeight: this.borderBoxHeight,
      totalSize: computeTotalSize(this.options),
      visibleRange,
      virtualItems: this.getVirtualItems(visibleRange),
    };
  }

  private getVisibleRange(): FixedRowVisibleRange {
    if (this.options.rowHeightIndex) {
      return computeVariableRowVisibleRange({
        rowHeightIndex: this.options.rowHeightIndex,
        scrollTop: this.scrollTop,
        viewportHeight: this.viewportHeight,
        enabled: this.options.enabled,
      });
    }

    return computeFixedRowVisibleRange({
      count: this.options.count,
      rowHeight: this.options.rowHeight,
      rowGap: this.options.rowGap,
      scrollTop: this.scrollTop,
      viewportHeight: this.viewportHeight,
      enabled: this.options.enabled,
    });
  }

  private getVirtualItems(range: FixedRowVisibleRange): readonly FixedRowVirtualItem[] {
    const count = this.options.count;
    if (!this.options.enabled || count === 0) {
      this.itemCache.clear();
      return [];
    }

    const window = computeOverscannedRange(count, range, this.options.overscan);
    if (this.options.rowHeightIndex)
      return collectVariableVirtualItems(this.options.rowHeightIndex, window);

    this.pruneItemCache(window);
    return this.collectVirtualItems(window);
  }

  private collectVirtualItems(range: FixedRowVisibleRange): FixedRowVirtualItem[] {
    const items: FixedRowVirtualItem[] = [];
    for (let index = range.start; index < range.end; index += 1) {
      items.push(this.getCachedVirtualItem(index));
    }

    return items;
  }

  private getCachedVirtualItem(index: number): FixedRowVirtualItem {
    const existing = this.itemCache.get(index);
    if (existing) return existing;

    const item = createVirtualItem(index, this.options.rowHeight, this.options.rowGap);
    this.itemCache.set(index, item);
    return item;
  }

  private pruneItemCache(range: FixedRowVisibleRange): void {
    for (const index of this.itemCache.keys()) {
      if (index >= range.start && index < range.end) continue;
      this.itemCache.delete(index);
    }
  }

  private updateCacheForFixedRows(rowHeight: number, rowGap: number): void {
    if (rowHeight === this.cachedRowHeight && rowGap === this.cachedRowGap) return;

    this.cachedRowHeight = rowHeight;
    this.cachedRowGap = rowGap;
    this.itemCache.clear();
  }

  private syncScrollPositionFromElement(): void {
    const element = this.attached?.element;
    if (!element) return;

    this.setScrollMetrics({
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      borderBoxHeight: this.borderBoxHeight,
      borderBoxWidth: this.borderBoxWidth,
      viewportHeight: this.viewportHeight,
      viewportWidth: this.viewportWidth,
    });
  }

  private syncFromResizeEntries(entries: readonly ResizeObserverEntry[]): void {
    const element = this.attached?.element;
    if (!element) return;

    const entry = resizeEntryForElement(entries, element);
    if (!entry) return;

    const size = resizeEntrySize(entry);
    this.setScrollMetrics({
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      borderBoxHeight: size.border.height,
      borderBoxWidth: size.border.width,
      viewportHeight: size.content.height,
      viewportWidth: size.content.width,
    });
  }

  private scheduleScrollSync(): void {
    if (this.scrollAnimationFrame !== 0) return;

    this.scrollAnimationFrame = requestFrame(() => {
      this.scrollAnimationFrame = 0;
      this.syncScrollPositionFromElement();
    });
  }

  private cancelScheduledScrollSync(): void {
    if (this.scrollAnimationFrame === 0) return;

    cancelFrame(this.scrollAnimationFrame);
    this.scrollAnimationFrame = 0;
  }

  private emitChange(): void {
    this.changeHandler?.(this.getSnapshot());
  }
}

function computeOverscannedRange(
  count: number,
  range: FixedRowVisibleRange,
  overscan: number | undefined,
): FixedRowVisibleRange {
  const normalizedOverscan = normalizeOverscan(overscan);
  return {
    start: clamp(range.start - normalizedOverscan, 0, count),
    end: clamp(range.end + normalizedOverscan, 0, count),
  };
}

function createVirtualItem(index: number, rowHeight: number, rowGap: number): FixedRowVirtualItem {
  return {
    index,
    start: index * (rowHeight + rowGap),
    size: rowHeight,
  };
}

type NormalizedFixedRowVirtualizerOptions = Required<
  Omit<FixedRowVirtualizerOptions, "rowSizes">
> & {
  readonly rowSizes: readonly number[] | null;
  readonly rowHeightIndex: RowHeightIndex | null;
};

function normalizeOptions(
  options: FixedRowVirtualizerOptions,
): NormalizedFixedRowVirtualizerOptions {
  const count = normalizeCount(options.count);
  const rowGap = normalizeRowGap(options.rowGap);
  const rowSizes = normalizeRowSizes(options.rowSizes, count);
  return {
    count,
    rowHeight: normalizeRowHeight(options.rowHeight),
    rowGap,
    rowSizes,
    rowHeightIndex: rowSizes ? createRowHeightIndex(rowSizes, rowGap) : null,
    overscan: normalizeOverscan(options.overscan),
    enabled: options.enabled ?? true,
  };
}

function denormalizeOptions(
  options: NormalizedFixedRowVirtualizerOptions,
): FixedRowVirtualizerOptions {
  return {
    count: options.count,
    rowHeight: options.rowHeight,
    rowGap: options.rowGap,
    rowSizes: options.rowSizes ?? undefined,
    overscan: options.overscan,
    enabled: options.enabled,
  };
}

function computeTotalSize(options: NormalizedFixedRowVirtualizerOptions): number {
  if (options.rowHeightIndex) return options.rowHeightIndex.totalSize;

  return computeFixedRowTotalSize(options.count, options.rowHeight, options.rowGap);
}

function computeVariableRowVisibleRange(options: {
  readonly rowHeightIndex: RowHeightIndex;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly enabled?: boolean;
}): FixedRowVisibleRange {
  const count = options.rowHeightIndex.rowSizes.length;
  if (options.enabled === false || count === 0) return { start: 0, end: 0 };

  const scrollTop = Math.max(0, normalizeNumber(options.scrollTop));
  const viewportHeight = Math.max(0, normalizeNumber(options.viewportHeight));
  const start = rowHeightIndexRowAtOffset(options.rowHeightIndex, scrollTop);
  const end = clamp(
    rowHeightIndexRowAfterOffset(options.rowHeightIndex, scrollTop + viewportHeight),
    start + 1,
    count,
  );
  return { start, end };
}

function collectVariableVirtualItems(
  rowHeightIndex: RowHeightIndex,
  range: FixedRowVisibleRange,
): FixedRowVirtualItem[] {
  const items: FixedRowVirtualItem[] = [];

  for (let index = range.start; index < range.end; index += 1) {
    items.push({
      index,
      start: rowHeightIndexStart(rowHeightIndex, index),
      size: rowHeightIndex.rowSizes[index] ?? DEFAULT_ROW_HEIGHT,
    });
  }

  return items;
}

function fixedRowIndexAtOffset(
  count: number,
  rowHeight: number,
  rowGap: number,
  offset: number,
): number {
  const stride = rowHeight + rowGap;
  const index = clamp(Math.floor(offset / stride), 0, count - 1);
  const rowBottom = index * stride + rowHeight;
  if (offset < rowBottom) return index;
  return Math.min(index + 1, count - 1);
}

function fixedRowIndexAfterOffset(
  count: number,
  rowHeight: number,
  rowGap: number,
  offset: number,
): number {
  const stride = rowHeight + rowGap;
  const index = clamp(Math.floor(offset / stride), 0, count);
  const rowStart = index * stride;
  if (offset <= rowStart) return index;
  return Math.min(index + 1, count);
}

function totalRowGap(count: number, rowGap: number): number {
  return Math.max(0, count - 1) * rowGap;
}

function normalizeRowSizes(
  rowSizes: readonly number[] | undefined,
  count: number,
): readonly number[] | null {
  if (!rowSizes || rowSizes.length !== count) return null;
  return rowSizes.map(normalizeRowHeight);
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeRowHeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ROW_HEIGHT;
  return value;
}

function normalizeRowGap(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) return DEFAULT_ROW_GAP;
  return value;
}

function normalizeOverscan(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value;
}

function optionalNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Math.max(0, normalizeNumber(value));
}

function optionalBorderBoxMetric(
  value: number | undefined,
  current: number,
  viewportValue: number,
  rawViewportValue: number | undefined,
): number {
  if (value !== undefined) return Math.max(0, normalizeNumber(value));
  if (rawViewportValue !== undefined) return viewportValue;
  return current;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resizeEntryForElement(
  entries: readonly ResizeObserverEntry[],
  element: Element,
): ResizeObserverEntry | null {
  for (const entry of entries) {
    if (entry.target === element) return entry;
  }

  return entries[0] ?? null;
}

function resizeEntrySize(entry: ResizeObserverEntry): {
  readonly content: {
    readonly width: number;
    readonly height: number;
  };
  readonly border: {
    readonly width: number;
    readonly height: number;
  };
} {
  const content = resizeObserverBox(entry.contentBoxSize) ?? {
    width: entry.contentRect.width,
    height: entry.contentRect.height,
  };
  const border = resizeObserverBox(entry.borderBoxSize) ?? content;
  return { content, border };
}

function resizeObserverBox(
  size: ResizeObserverEntry["contentBoxSize"],
): { readonly width: number; readonly height: number } | null {
  const box = Array.isArray(size) ? size[0] : size;
  if (!box) return null;
  return { width: box.inlineSize, height: box.blockSize };
}

function createResizeObserver(callback: ResizeObserverCallback): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  return new ResizeObserver(callback);
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(() => callback(nowMs()), 0) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }

  clearTimeout(handle);
}

function nowMs(): DOMHighResTimeStamp {
  return globalThis.performance?.now() ?? Date.now();
}
