import { describe, expect, it, vi } from "vitest";
import {
  FixedRowVirtualizer,
  computeFixedRowTotalSize,
  computeFixedRowVisibleRange,
  computeFixedRowVirtualItems,
} from "../src";

describe("fixed row virtualizer", () => {
  it("computes total scroll height from count and row height", () => {
    expect(computeFixedRowTotalSize(100_000, 18)).toBe(1_800_000);
    expect(computeFixedRowTotalSize(-1, 18)).toBe(0);
    expect(computeFixedRowTotalSize(2, 0)).toBe(2);
  });

  it("computes an exclusive visible range from scroll metrics", () => {
    const range = computeFixedRowVisibleRange({
      count: 100,
      rowHeight: 20,
      scrollTop: 45,
      viewportHeight: 50,
    });

    expect(range).toEqual({ start: 2, end: 5 });
  });

  it("keeps one row visible when the viewport has zero height", () => {
    const range = computeFixedRowVisibleRange({
      count: 100,
      rowHeight: 20,
      scrollTop: 40,
      viewportHeight: 0,
    });

    expect(range).toEqual({ start: 2, end: 3 });
  });

  it("computes overscanned virtual items", () => {
    const items = computeFixedRowVirtualItems({
      count: 100,
      rowHeight: 20,
      range: { start: 10, end: 13 },
      overscan: 2,
    });

    expect(items).toEqual([
      { index: 8, start: 160, size: 20 },
      { index: 9, start: 180, size: 20 },
      { index: 10, start: 200, size: 20 },
      { index: 11, start: 220, size: 20 },
      { index: 12, start: 240, size: 20 },
      { index: 13, start: 260, size: 20 },
      { index: 14, start: 280, size: 20 },
    ]);
  });

  it("computes fixed row gaps without adding a trailing gap", () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 3,
      rowHeight: 20,
      rowGap: 4,
      overscan: 0,
    });

    virtualizer.setScrollMetrics({ scrollTop: 21, viewportHeight: 25 });

    expect(virtualizer.getSnapshot()).toMatchObject({
      totalSize: 68,
      visibleRange: { start: 1, end: 2 },
      virtualItems: [{ index: 1, start: 24, size: 20 }],
    });
  });

  it("reuses stable virtual item records while a row remains mounted", () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 20,
      overscan: 1,
    });

    virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 60 });
    const first = virtualizer.getSnapshot().virtualItems;
    const rowTwo = first.find((item) => item.index === 2);

    virtualizer.setScrollMetrics({ scrollTop: 5, viewportHeight: 60 });
    const second = virtualizer.getSnapshot().virtualItems;
    const nextRowTwo = second.find((item) => item.index === 2);

    expect(nextRowTwo).toBe(rowTwo);
  });

  it("can attach to a fresh scroll element without reading scroll offsets", () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 20,
    });
    const element = document.createElement("div");
    const scrollTop = vi.spyOn(element, "scrollTop", "get");
    const scrollLeft = vi.spyOn(element, "scrollLeft", "get");

    virtualizer.attachScrollElement(element, undefined, {
      readInitialScrollPosition: false,
    });

    expect(scrollTop).not.toHaveBeenCalled();
    expect(scrollLeft).not.toHaveBeenCalled();

    virtualizer.dispose();
  });

  it("tracks the viewport border box separately from the content box", () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 20,
    });

    virtualizer.setScrollMetrics({
      scrollTop: 0,
      viewportHeight: 60,
      viewportWidth: 80,
      borderBoxHeight: 72,
      borderBoxWidth: 96,
    });

    expect(virtualizer.getSnapshot()).toMatchObject({
      borderBoxHeight: 72,
      borderBoxWidth: 96,
      viewportHeight: 60,
      viewportWidth: 80,
    });
  });

  it("clears stable records when row height changes", () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 100,
      rowHeight: 20,
      overscan: 1,
    });

    virtualizer.setScrollMetrics({ scrollTop: 0, viewportHeight: 60 });
    const rowOne = virtualizer.getSnapshot().virtualItems[1];
    virtualizer.updateOptions({ rowHeight: 24 });

    expect(virtualizer.getSnapshot().virtualItems[1]).not.toBe(rowOne);
    expect(virtualizer.getSnapshot().virtualItems[1]).toEqual({
      index: 1,
      start: 24,
      size: 24,
    });
  });

  it("supports variable row sizes", () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 3,
      rowHeight: 20,
      rowSizes: [20, 60, 20],
      overscan: 0,
    });

    virtualizer.setScrollMetrics({ scrollTop: 30, viewportHeight: 40 });

    expect(virtualizer.getSnapshot()).toMatchObject({
      totalSize: 100,
      visibleRange: { start: 1, end: 2 },
      virtualItems: [{ index: 1, start: 20, size: 60 }],
    });
  });

  it("applies row gaps between variable rows", () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 3,
      rowHeight: 20,
      rowGap: 4,
      rowSizes: [20, 60, 20],
      overscan: 0,
    });

    virtualizer.setScrollMetrics({ scrollTop: 22, viewportHeight: 40 });

    expect(virtualizer.getSnapshot()).toMatchObject({
      totalSize: 108,
      visibleRange: { start: 1, end: 2 },
      virtualItems: [{ index: 1, start: 24, size: 60 }],
    });
  });

  it("caps native scroll height while preserving logical scroll offsets", () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 1_000,
      maxScrollHeight: 1_000,
      overscan: 0,
      rowHeight: 100,
    });

    virtualizer.setScrollMetrics({ scrollTop: 99_900, viewportHeight: 100 });

    expect(virtualizer.getSnapshot()).toMatchObject({
      nativeScrollHeight: 1_000,
      nativeScrollTop: 900,
      scrollHeight: 100_000,
      scrollTop: 99_900,
      visibleRange: { start: 999, end: 1_000 },
    });
  });

  it("keeps large-file rows addressable past native browser scroll caps", () => {
    const targetRow = 699_051;
    const virtualizer = new FixedRowVirtualizer({
      count: targetRow + 100,
      overscan: 0,
      rowHeight: 48,
    });

    virtualizer.setScrollMetrics({
      scrollTop: targetRow * 48,
      viewportHeight: 480,
    });

    expect(virtualizer.getSnapshot()).toMatchObject({
      nativeScrollHeight: 16_000_000,
      visibleRange: { start: targetRow, end: targetRow + 10 },
    });
  });

  it("exposes logical scroll metrics on attached scroll elements", () => {
    const virtualizer = new FixedRowVirtualizer({
      count: 1_000,
      maxScrollHeight: 1_000,
      overscan: 0,
      rowHeight: 100,
    });
    const element = document.createElement("div");

    virtualizer.attachScrollElement(element, undefined, {
      readInitialScrollPosition: false,
    });
    virtualizer.setScrollMetrics({ scrollTop: 99_900, viewportHeight: 100 });

    expect(element.scrollHeight).toBe(100_000);
    expect(element.scrollTop).toBe(99_900);

    element.scrollTop = 49_950;

    expect(virtualizer.getSnapshot()).toMatchObject({
      nativeScrollTop: 450,
      scrollTop: 49_950,
      visibleRange: { start: 499, end: 501 },
    });

    virtualizer.dispose();
  });
});
