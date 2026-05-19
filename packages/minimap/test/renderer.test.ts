import { describe, expect, it } from "vitest";
import { MinimapWorkerRenderer, projectMinimapTokensThroughEdit } from "../src/renderer";
import { resolveMinimapOptions } from "../src/options";

describe("MinimapWorkerRenderer", () => {
  it("ignores updates before initialization", () => {
    const renderer = new MinimapWorkerRenderer();

    renderer.setDocument({
      text: "a",
      lineStarts: [0],
      tokens: [],
      selections: [],
      decorations: [],
    });
    renderer.updateViewport({
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 20,
      scrollWidth: 20,
      clientHeight: 20,
      clientWidth: 20,
      visibleStart: 0,
      visibleEnd: 1,
    });

    expect(renderer.render()).toBeNull();
  });

  it("reports a clear error when a canvas context cannot be created", () => {
    const renderer = new MinimapWorkerRenderer();
    const canvas = { getContext: () => null } as unknown as OffscreenCanvas;

    expect(() =>
      renderer.init({
        mainCanvas: canvas,
        decorationsCanvas: canvas,
        options: resolveMinimapOptions(),
        styles: {
          background: { r: 0, g: 0, b: 0, a: 255 },
          foreground: { r: 255, g: 255, b: 255, a: 255 },
          foregroundOpacity: 1,
          selection: { r: 10, g: 20, b: 30, a: 255 },
          minimapBackground: { r: 0, g: 0, b: 0, a: 255 },
          slider: "rgba(255, 255, 255, 0.2)",
          sliderHover: "rgba(255, 255, 255, 0.3)",
          sliderActive: "rgba(255, 255, 255, 0.4)",
          fontFamily: "monospace",
        },
      }),
    ).toThrow("Unable to create minimap canvas context");
  });

  it("projects minimap token ranges through same-line insertions", () => {
    const color = { r: 255, g: 0, b: 0, a: 255 };
    const tokens = [
      { start: 0, end: 5, color },
      { start: 6, end: 10, color },
    ];

    expect(
      projectMinimapTokensThroughEdit(tokens, { from: 2, to: 2, text: "X" }, "alpha beta"),
    ).toEqual([
      { start: 0, end: 6, color },
      { start: 7, end: 11, color },
    ]);
  });

  it("drops minimap tokens invalidated by multi-line edits", () => {
    const color = { r: 255, g: 0, b: 0, a: 255 };
    const tokens = [
      { start: 0, end: 5, color },
      { start: 6, end: 10, color },
    ];

    expect(
      projectMinimapTokensThroughEdit(tokens, { from: 2, to: 4, text: "\n" }, "alpha beta"),
    ).toEqual([{ start: 5, end: 9, color }]);
  });
});
