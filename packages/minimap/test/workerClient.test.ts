import { describe, expect, it, vi } from "vitest";
import { type DocumentSessionChange, type EditorViewSnapshot, type TextEdit } from "@editor/core";
import { resolveMinimapOptions } from "../src/options";
import { MinimapWorkerClient, type MinimapHost } from "../src/workerClient";
import type { MinimapWorkerRequest, MinimapWorkerResponse } from "../src/types";

describe("MinimapWorkerClient", () => {
  it("skips layout updates for scroll-only viewport changes", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({ scrollTop: 0 }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      client.update(snapshot({ scrollTop: 120, visibleRange: { start: 6, end: 18 } }), "viewport");
      runtime.flushAnimationFrames();

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string });

      expect(requests.map((request) => request.type)).toEqual(["updateViewport", "render"]);

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });

  it("keeps layout stable for same-line edits that only change content width", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      const edit: TextEdit = { from: 6, to: 6, text: "x" };
      client.update(
        snapshot({ scrollWidth: 168 }, { text: "line 1x\nline 2\nline 3", contentWidth: 168 }),
        "content",
        documentEdit(edit, "line 1x\nline 2\nline 3"),
      );
      runtime.flushAnimationFrames();

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string });

      expect(requests.map((request) => request.type)).toEqual([
        "applyEdit",
        "updateViewport",
        "render",
      ]);

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });

  it("keeps full token payloads out of same-line edit updates", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({}, { tokens: [{ start: 0, end: 6, style: { color: "#ff0000" } }] }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      const edit: TextEdit = { from: 6, to: 6, text: "x" };
      client.update(
        snapshot(
          { scrollWidth: 168 },
          {
            text: "line 1x\nline 2\nline 3",
            contentWidth: 168,
            tokens: [{ start: 0, end: 7, style: { color: "#ff0000" } }],
          },
        ),
        "content",
        documentEdit(edit, "line 1x\nline 2\nline 3"),
      );
      runtime.flushAnimationFrames();

      const applyEdit = worker.postMessage.mock.calls[0]?.[0] as Extract<
        MinimapWorkerRequest,
        { type: "applyEdit" }
      >;

      expect(applyEdit.type).toBe("applyEdit");
      expect("tokens" in applyEdit.document).toBe(false);
      expect("lineStarts" in applyEdit.document).toBe(false);

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });

  it("uses incremental updates for same-line deletions", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({}, { text: "abc" }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      const edit: TextEdit = { from: 2, to: 3, text: "" };
      client.update(snapshot({}, { text: "ab" }), "content", documentEdit(edit, "ab"));
      runtime.flushAnimationFrames();

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string });

      expect(requests.map((request) => request.type)).toEqual([
        "applyEdit",
        "updateViewport",
        "render",
      ]);

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });

  it("uses incremental updates for multi-line deletions", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({}, { text: "line 1\nline 2\nline 3" }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      const edit: TextEdit = { from: 6, to: 7, text: "" };
      client.update(
        snapshot({}, { text: "line 1line 2\nline 3" }),
        "content",
        documentEdit(edit, "line 1line 2\nline 3"),
      );
      runtime.flushAnimationFrames();

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string });

      expect(requests.map((request) => request.type)).toEqual([
        "applyEdit",
        "updateLayout",
        "render",
      ]);

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });

  it("queues incremental edits while a render is in flight", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      const firstEdit: TextEdit = { from: 6, to: 6, text: "x" };
      client.update(
        snapshot({}, { text: "line 1x\nline 2\nline 3" }),
        "content",
        documentEdit(firstEdit, "line 1x\nline 2\nline 3"),
      );
      runtime.flushAnimationFrames();
      worker.postMessage.mockClear();

      const secondEdit: TextEdit = { from: 7, to: 7, text: "y" };
      const thirdEdit: TextEdit = { from: 8, to: 8, text: "z" };
      client.update(
        snapshot({}, { text: "line 1xy\nline 2\nline 3" }),
        "content",
        documentEdit(secondEdit, "line 1xy\nline 2\nline 3"),
      );
      client.update(
        snapshot({}, { text: "line 1xyz\nline 2\nline 3" }),
        "content",
        documentEdit(thirdEdit, "line 1xyz\nline 2\nline 3"),
      );
      runtime.flushAnimationFrames();

      expect(worker.postMessage).not.toHaveBeenCalled();

      worker.send(renderedResponse(2));
      runtime.flushAnimationFrames();

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest);
      const applyEdits = requests[0] as Extract<MinimapWorkerRequest, { type: "applyEdits" }>;

      expect(requests.map((request) => request.type)).toEqual([
        "applyEdits",
        "updateViewport",
        "render",
      ]);
      expect(applyEdits.edits).toEqual([secondEdit, thirdEdit]);
      expect("lineStarts" in applyEdits.document).toBe(false);

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });

  it("uses incremental updates for batched same-line edits", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({}, { text: "abc def ghi" }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      const edits: readonly TextEdit[] = [
        { from: 0, to: 0, text: "x" },
        { from: 4, to: 4, text: "y" },
      ];
      client.update(
        snapshot({}, { text: "xabc ydef ghi" }),
        "content",
        documentEdits(edits, "xabc ydef ghi"),
      );
      runtime.flushAnimationFrames();

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest);
      const applyEdits = requests[0] as Extract<MinimapWorkerRequest, { type: "applyEdits" }>;

      expect(requests.map((request) => request.type)).toEqual([
        "applyEdits",
        "updateViewport",
        "render",
      ]);
      expect(applyEdits.edits).toEqual([
        { from: 0, to: 0, text: "x" },
        { from: 5, to: 5, text: "y" },
      ]);
      expect("lineStarts" in applyEdits.document).toBe(false);

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });

  it("sends external decoration updates without a full decoration payload", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      const decoration = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 2,
        color: "#ff0000",
        position: "inline" as const,
      };
      client.setExternalDecorations(snapshot(), [decoration]);
      runtime.flushAnimationFrames();

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest);

      expect(requests.map((request) => request.type)).toEqual([
        "updateExternalDecorations",
        "render",
      ]);
      expect(requests[0]).toMatchObject({
        type: "updateExternalDecorations",
        decorations: [decoration],
      });

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });

  it("sends token range patches after incremental edit token refreshes", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(
          {},
          {
            tokens: [
              { start: 0, end: 6, style: { color: "#ff0000" } },
              { start: 7, end: 11, style: { color: "#00ff00" } },
              { start: 12, end: 18, style: { color: "#0000ff" } },
            ],
          },
        ),
        decorations: [],
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      const edit: TextEdit = { from: 6, to: 6, text: "x" };
      const projectedTokens = [
        { start: 0, end: 7, style: { color: "#ff0000" } },
        { start: 8, end: 12, style: { color: "#00ff00" } },
        { start: 13, end: 19, style: { color: "#0000ff" } },
      ];
      client.update(
        snapshot({}, { text: "line 1x\nline 2\nline 3", tokens: projectedTokens }),
        "content",
        documentEdit(edit, "line 1x\nline 2\nline 3"),
      );
      runtime.flushAnimationFrames();
      worker.send(renderedResponse(2));
      worker.postMessage.mockClear();

      client.update(
        snapshot(
          {},
          {
            text: "line 1x\nline 2\nline 3",
            tokens: [
              projectedTokens[0]!,
              { start: 8, end: 12, style: { color: "#ffffff" } },
              projectedTokens[2]!,
            ],
          },
        ),
        "tokens",
      );
      runtime.flushAnimationFrames();

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest);
      const tokenPatch = requests[0] as Extract<MinimapWorkerRequest, { type: "updateTokenRange" }>;

      expect(requests.map((request) => request.type)).toEqual(["updateTokenRange", "render"]);
      expect(tokenPatch.patch).toMatchObject({
        start: 1,
        deleteCount: 1,
        tokens: [{ start: 8, end: 12 }],
      });

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });
});

function createHost(): MinimapHost {
  const root = document.createElement("div");
  const colorScope = document.createElement("div");
  const shadow = document.createElement("div");
  const mainCanvas = document.createElement("canvas");
  const decorationsCanvas = document.createElement("canvas");
  const slider = document.createElement("div");
  const sliderHorizontal = document.createElement("div");
  colorScope.style.color = "rgb(212, 212, 212)";
  colorScope.style.backgroundColor = "rgb(30, 30, 30)";
  slider.appendChild(sliderHorizontal);
  root.append(shadow, mainCanvas, decorationsCanvas, slider);
  document.body.append(colorScope, root);
  return { root, colorScope, shadow, mainCanvas, decorationsCanvas, slider, sliderHorizontal };
}

function snapshot(
  viewport: Partial<EditorViewSnapshot["viewport"]> = {},
  overrides: Partial<Pick<EditorViewSnapshot, "contentWidth" | "text" | "tokens">> = {},
): EditorViewSnapshot {
  const text = overrides.text ?? "line 1\nline 2\nline 3";
  const starts = lineStarts(text);
  const contentWidth = overrides.contentWidth ?? 160;
  return {
    documentId: "minimap-test",
    languageId: "typescript",
    text,
    textVersion: 1,
    lineStarts: starts,
    tokens: overrides.tokens ?? [],
    selections: [],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: starts.length,
    contentWidth,
    totalHeight: 60,
    tabSize: 4,
    foldMarkers: [],
    visibleRows: [],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 400,
      scrollWidth: contentWidth,
      clientHeight: 100,
      clientWidth: 240,
      borderBoxHeight: 100,
      borderBoxWidth: 240,
      visibleRange: { start: 0, end: 3 },
      ...viewport,
    },
  };
}

function documentEdit(edit: TextEdit, text: string): DocumentSessionChange {
  return documentEdits([edit], text);
}

function documentEdits(edits: readonly TextEdit[], text: string): DocumentSessionChange {
  return { kind: "edit", edits, text } as unknown as DocumentSessionChange;
}

function lineStarts(text: string): readonly number[] {
  const starts = [0];
  let index = text.indexOf("\n");
  while (index !== -1) {
    starts.push(index + 1);
    index = text.indexOf("\n", index + 1);
  }
  return starts;
}

function renderedResponse(sequence: number): MinimapWorkerResponse {
  return {
    type: "rendered",
    sequence,
    sliderNeeded: true,
    sliderTop: 0,
    sliderHeight: 20,
    shadowVisible: false,
  };
}

function installMinimapRuntime(): {
  readonly workers: MockWorker[];
  readonly flushAnimationFrames: () => void;
  readonly restore: () => void;
} {
  const workers: MockWorker[] = [];
  const frames: (() => void)[] = [];
  const worker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const offscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  const requestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  const cancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const transferControlToOffscreen = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "transferControlToOffscreen",
  );

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: class extends MockWorker {
      public constructor(url: URL, options?: WorkerOptions) {
        super(url, options);
        workers.push(this);
      }
    },
  });
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: class MockOffscreenCanvas {},
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
    configurable: true,
    value: () => ({}),
  });

  return {
    workers,
    flushAnimationFrames: () => {
      for (const frame of frames.splice(0)) frame();
    },
    restore: () => {
      restoreDescriptor(globalThis, "Worker", worker);
      restoreDescriptor(globalThis, "OffscreenCanvas", offscreenCanvas);
      restoreDescriptor(globalThis, "requestAnimationFrame", requestAnimationFrame);
      restoreDescriptor(globalThis, "cancelAnimationFrame", cancelAnimationFrame);
      restoreDescriptor(
        HTMLCanvasElement.prototype,
        "transferControlToOffscreen",
        transferControlToOffscreen,
      );
    },
  };
}

class MockWorker {
  public onmessage: ((event: MessageEvent<MinimapWorkerResponse>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public postMessage = vi.fn();
  public terminate = vi.fn();

  public constructor(_url: URL, _options?: WorkerOptions) {}

  public send(response: MinimapWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<MinimapWorkerResponse>);
  }
}

function restoreDescriptor(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }

  Reflect.deleteProperty(target, property);
}
