import type {
  DocumentSessionChange,
  EditorCommandId,
  EditorFeatureContributionContext,
  EditorMinimapFeature,
  EditorPluginContext,
  EditorCommandHandler,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewSnapshot,
  TextEdit,
} from "@editor/core";
import { EDITOR_MINIMAP_FEATURE_ID } from "@editor/core";
import type { LspWebSocketLike, LspWorkerLike } from "@editor/lsp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTypeScriptLspPlugin, type TypeScriptLspDiagnosticSummary } from "../src";

type Listener = (event: Event) => void;
type JsonMessage = Record<string, unknown>;

class FakeWorker implements LspWorkerLike {
  public readonly sent: unknown[] = [];
  public terminated = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public addEventListener(type: "message" | "error", handler: Listener): void {
    this.listenersFor(type).add(handler);
  }

  public removeEventListener(type: "message" | "error", handler: Listener): void {
    this.listenersFor(type).delete(handler);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public receive(message: unknown): void {
    const event = new MessageEvent("message", { data: message });
    for (const listener of this.listenersFor("message")) listener(event);
  }

  private listenersFor(type: string): Set<Listener> {
    let listeners = this.listeners.get(type);
    if (listeners) return listeners;

    listeners = new Set();
    this.listeners.set(type, listeners);
    return listeners;
  }
}

class FakeWebSocket implements LspWebSocketLike {
  public static readonly instances: FakeWebSocket[] = [];
  public readonly sent: string[] = [];
  public readyState = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  public constructor(
    public readonly url: string | URL,
    public readonly protocols?: string | readonly string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  public send(message: string): void {
    this.sent.push(message);
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  public addEventListener(type: "open" | "message" | "error" | "close", handler: Listener): void {
    this.listenersFor(type).add(handler);
  }

  public removeEventListener(
    type: "open" | "message" | "error" | "close",
    handler: Listener,
  ): void {
    this.listenersFor(type).delete(handler);
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  public receive(message: unknown): void {
    this.emit("message", JSON.stringify(message));
  }

  private emit(type: string, data?: unknown): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    for (const listener of this.listenersFor(type)) listener(event);
  }

  private listenersFor(type: string): Set<Listener> {
    let listeners = this.listeners.get(type);
    if (listeners) return listeners;

    listeners = new Set();
    this.listeners.set(type, listeners);
    return listeners;
  }
}

describe("createTypeScriptLspPlugin", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("syncs the active TypeScript document through a worker and renders diagnostics", async () => {
    const worker = new FakeWorker();
    const diagnostics: TypeScriptLspDiagnosticSummary[] = [];
    const context = viewContributionContext(editorSnapshot());
    const plugin = createTypeScriptLspPlugin({
      diagnosticDelayMs: 0,
      workerFactory: () => worker,
      onDiagnostics: (summary) => diagnostics.push(summary),
    });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    const initialize = message(worker.sent[0]);
    worker.receive(initializeResponse(initialize));
    await flushPromises();

    expect(sentMethods(worker)).toContain("textDocument/didOpen");
    expect(textDocumentFor(worker.sent.find(hasMethod("textDocument/didOpen")))).toMatchObject({
      uri: "file:///src/index.ts",
      languageId: "typescript",
      version: 0,
      text: "const value: string = 1;",
    });

    worker.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///src/index.ts",
        version: 0,
        diagnostics: [
          {
            severity: 1,
            source: "typescript",
            message: "bad assignment",
            range: {
              start: { line: 0, character: 22 },
              end: { line: 0, character: 23 },
            },
          },
        ],
      },
    });

    expect(context.setRangeHighlight).toHaveBeenCalledWith(
      "editor-test-typescript-lsp-error",
      [{ start: 22, end: 23 }],
      expect.objectContaining({
        color: "rgba(248, 113, 113, 1)",
        textDecoration: expect.stringContaining("wavy"),
      }),
    );
    expect(diagnostics.at(-1)?.counts).toMatchObject({ error: 1, total: 1 });

    contribution.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("syncs active JavaScript documents through the TypeScript language service", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({
        documentId: "src/index.js",
        languageId: "javascript",
        text: "const value = 1;",
      }),
    );
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();

    expect(textDocumentFor(worker.sent.find(hasMethod("textDocument/didOpen")))).toMatchObject({
      uri: "file:///src/index.js",
      languageId: "javascript",
      version: 0,
      text: "const value = 1;",
    });

    contribution.dispose();
  });

  it("does not attach the TypeScript language service to Markdown documents", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({
        documentId: "README.md",
        languageId: "markdown",
        text: "# Notes",
      }),
    );
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();

    expect(sentMethods(worker)).not.toContain("textDocument/didOpen");

    contribution.dispose();
  });

  it("publishes diagnostic line markers to the minimap feature", async () => {
    const worker = new FakeWorker();
    const minimap = minimapFeature();
    const context = viewContributionContext(
      editorSnapshot({
        text: "const value = 1;\nconst next: string = 2;\n",
        lineCount: 3,
        lineStarts: [0, 17, 40],
      }),
    );
    vi.mocked(context.getFeature!).mockImplementation((id) =>
      id === EDITOR_MINIMAP_FEATURE_ID ? minimap : null,
    );
    const plugin = createTypeScriptLspPlugin({
      diagnosticDelayMs: 0,
      workerFactory: () => worker,
    });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    worker.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///src/index.ts",
        version: 0,
        diagnostics: [
          {
            severity: 1,
            source: "typescript",
            message: "bad assignment",
            range: {
              start: { line: 1, character: 21 },
              end: { line: 1, character: 22 },
            },
          },
        ],
      },
    });

    expect(minimap.setDecorations).toHaveBeenCalledWith("editor.typescript-lsp.diagnostics", [
      expect.objectContaining({
        startLineNumber: 2,
        endLineNumber: 2,
        color: "rgba(239, 68, 68, 1)",
        position: "inline",
      }),
    ]);

    contribution.dispose();
    expect(minimap.clearDecorations).toHaveBeenCalledWith("editor.typescript-lsp.diagnostics");
  });

  it("sends loaded workspace files to the worker", async () => {
    const worker = new FakeWorker();
    const plugin = createTypeScriptLspPlugin({
      workerFactory: () => worker,
    });
    const provider = activatePlugin(plugin);
    provider.createContribution(viewContributionContext(editorSnapshot()));

    const initialize = message(worker.sent[0]);
    worker.receive(initializeResponse(initialize));
    await flushPromises();
    plugin.setWorkspaceFiles([{ path: "src/other.ts", text: "export const other = 1;" }]);
    await flushPromises();

    const workspaceMessage = worker.sent
      .toReversed()
      .find(hasMethod("editor/typescript/setWorkspaceFiles"));
    expect(message(workspaceMessage).params).toEqual({
      files: [{ path: "src/other.ts", text: "export const other = 1;" }],
    });
  });

  it("stops feature requests after initialization fails", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const errors: unknown[] = [];
    const context = viewContributionContext(editorSnapshot());
    const plugin = createTypeScriptLspPlugin({
      timeoutMs: 5,
      workerFactory: () => worker,
      onError: (error) => errors.push(error),
    });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    await vi.advanceTimersByTimeAsync(6);
    await flushPromises();

    expect(errors).toHaveLength(1);
    expect(worker.terminated).toBe(true);

    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 12, clientY: 16, buttons: 0 }),
    );
    await vi.advanceTimersByTimeAsync(260);
    plugin.setWorkspaceFiles([{ path: "src/other.ts", text: "export const other = 1;" }]);
    await flushPromises();

    expect(errors).toHaveLength(1);
    expect(worker.sent.filter(hasMethod("textDocument/hover"))).toHaveLength(0);
    expect(worker.sent.filter(hasMethod("editor/typescript/setWorkspaceFiles"))).toHaveLength(0);
  });

  it("can connect through a WebSocket route and keep diagnostics and hover working", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    const diagnostics: TypeScriptLspDiagnosticSummary[] = [];
    const context = viewContributionContext(editorSnapshot());
    const plugin = createTypeScriptLspPlugin({
      webSocketRoute: "ws://localhost/lsp/typescript",
      webSocketTransportOptions: { WebSocketCtor: FakeWebSocket },
      onDiagnostics: (summary) => diagnostics.push(summary),
    });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("missing socket");

    socket.open();
    await flushPromises();
    const initialize = jsonMessage(socket.sent[0]);
    socket.receive(initializeResponse(initialize));
    await flushPromises();

    expect(sentSocketMethods(socket)).toContain("textDocument/didOpen");
    socket.receive(publishDiagnosticsMessage());
    expect(diagnostics.at(-1)?.counts).toMatchObject({ error: 1, total: 1 });

    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 12, clientY: 16, buttons: 0 }),
    );
    await vi.advanceTimersByTimeAsync(260);
    const hoverRequest = jsonMessage(
      socket.sent.toReversed().find(hasSocketMethod("textDocument/hover")),
    );
    socket.receive({
      jsonrpc: "2.0",
      id: hoverRequest.id,
      result: {
        contents: { kind: "markdown", value: "```ts\nconst value: string\n```" },
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      },
    });
    await flushPromises();

    expect(tooltipElement().querySelector("pre > code")?.textContent).toBe("const value: string");
  });

  it("ignores stale diagnostics for older document versions", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(editorSnapshot());
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    contribution.update(
      editorSnapshot({ text: "const value: string = 2;", textVersion: 2 }),
      "content",
      documentChange([{ from: 22, to: 23, text: "2" }]),
    );
    vi.mocked(context.setRangeHighlight!).mockClear();

    worker.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///src/index.ts",
        version: 0,
        diagnostics: [
          {
            severity: 1,
            message: "stale",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        ],
      },
    });

    expect(context.setRangeHighlight).not.toHaveBeenCalled();
  });

  it("optimistically shortens diagnostic highlights through local deletion", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(editorSnapshot({ text: "const value: string = 123;" }));
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    worker.receive(
      publishDiagnosticsMessage({
        range: {
          start: { line: 0, character: 22 },
          end: { line: 0, character: 25 },
        },
      }),
    );

    contribution.update(
      editorSnapshot({ text: "const value: string = 1;", textVersion: 2 }),
      "content",
      documentChange([{ from: 23, to: 25, text: "" }]),
    );

    expect(latestRangeHighlightRanges(context, "editor-test-typescript-lsp-error")).toEqual([
      { start: 22, end: 23 },
    ]);
  });

  it("optimistically clears diagnostic highlights when local deletion removes the range", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(editorSnapshot({ text: "const value: string = 123;" }));
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    worker.receive(
      publishDiagnosticsMessage({
        range: {
          start: { line: 0, character: 22 },
          end: { line: 0, character: 25 },
        },
      }),
    );

    contribution.update(
      editorSnapshot({ text: "const value: string = ;", textVersion: 2 }),
      "content",
      documentChange([{ from: 22, to: 25, text: "" }]),
    );

    expect(latestRangeHighlightRanges(context, "editor-test-typescript-lsp-error")).toEqual([]);
  });

  it("renders hover quick info with diagnostics at the pointer", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const context = viewContributionContext(
      editorSnapshot({
        theme: {
          foregroundColor: "#24292f",
          syntax: { keyword: "#cf222e" },
        },
      }),
    );
    context.scrollElement.style.setProperty("--editor-background", "rgb(250, 250, 250)");
    context.scrollElement.style.setProperty("--editor-foreground", "rgb(15, 23, 42)");
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    worker.receive(publishDiagnosticsMessage());

    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 12, clientY: 16, buttons: 0 }),
    );
    await vi.advanceTimersByTimeAsync(260);
    const hoverRequest = message(worker.sent.toReversed().find(hasMethod("textDocument/hover")));
    expect(hoverRequest.params).toMatchObject({
      textDocument: { uri: "file:///src/index.ts" },
      position: { line: 0, character: 22 },
    });

    worker.receive({
      jsonrpc: "2.0",
      id: hoverRequest.id,
      result: {
        contents: { kind: "markdown", value: "```ts\nconst value: string\n```" },
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      },
    });
    await flushPromises();

    expect(document.body.textContent).toContain("const value: string");
    expect(document.body.textContent).toContain("bad assignment");
    expect(tooltipElement().querySelector("pre > code")?.textContent).toBe("const value: string");
    expect(
      tooltipElement()
        .querySelector<HTMLElement>(".editor-typescript-lsp-hover-markdown")
        ?.style.getPropertyValue("--editor-typescript-lsp-hover-code-block-background"),
    ).toBe("");
    expect(tooltipElement().style.getPropertyValue("position-anchor")).toMatch(
      /^--editor-typescript-lsp-hover-/,
    );
    expect(tooltipElement().style.getPropertyValue("position-area")).toBe("bottom center");
    expect(tooltipElement().style.overflow).toBe("hidden");
    expect(tooltipElement().style.pointerEvents).toBe("auto");
    expect(tooltipElement().style.userSelect).toBe("text");
    expect(tooltipElement().style.getPropertyValue("--editor-background")).toBe(
      "rgb(250, 250, 250)",
    );
    expect(tooltipElement().style.getPropertyValue("--editor-foreground")).toBe("rgb(15, 23, 42)");
    expect(
      tooltipElement()
        .querySelector<HTMLElement>(".editor-typescript-lsp-hover-markdown")
        ?.style.getPropertyValue("--editor-syntax-keyword"),
    ).toBe("#cf222e");
    expect(tooltipBody()?.style.overflowY).toBe("auto");
    expect(tooltipAnchorElement().style.display).toBe("block");
    expect(copyButton().textContent).toBe("");
    expect(copyButton().querySelector("svg")).not.toBeNull();
    expect(copyButton().getAttribute("aria-label")).toBe("Copy hover text");
    expect(copyButton().style.background).toBe("transparent");

    const hoverRequestCount = worker.sent.filter(hasMethod("textDocument/hover")).length;
    mockElementRect(tooltipElement(), new DOMRect(0, 0, 160, 72));
    mockElementRect(tooltipAnchorElement(), new DOMRect(12, 78, 40, 18));
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(3);
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 18, clientY: 76, buttons: 0 }),
    );
    await vi.advanceTimersByTimeAsync(260);
    expect(worker.sent.filter(hasMethod("textDocument/hover"))).toHaveLength(hoverRequestCount);

    copyButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("const value: string\n\nerror: bad assignment");
    expect(copyButton().getAttribute("aria-label")).toBe("Copied hover text");

    context.scrollElement.dispatchEvent(new PointerEvent("pointerleave"));
    tooltipElement().dispatchEvent(new PointerEvent("pointerenter"));
    await vi.advanceTimersByTimeAsync(190);
    expect(tooltipElement().hidden).toBe(false);

    tooltipElement().dispatchEvent(new PointerEvent("pointerleave"));
    await vi.advanceTimersByTimeAsync(190);
    expect(tooltipElement().hidden).toBe(true);
  });

  it("can opt hover Markdown code backgrounds back in", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const context = viewContributionContext(editorSnapshot());
    const plugin = createTypeScriptLspPlugin({
      hoverMarkdownCodeBackground: true,
      workerFactory: () => worker,
    });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 12, clientY: 16, buttons: 0 }),
    );
    await vi.advanceTimersByTimeAsync(260);

    const hoverRequest = message(worker.sent.toReversed().find(hasMethod("textDocument/hover")));
    worker.receive({
      jsonrpc: "2.0",
      id: hoverRequest.id,
      result: {
        contents: { kind: "markdown", value: "`value`\n\n```ts\nconst value: string\n```" },
      },
    });
    await flushPromises();

    expect(
      tooltipElement()
        .querySelector<HTMLElement>(".editor-typescript-lsp-hover-markdown")
        ?.style.getPropertyValue("--editor-typescript-lsp-hover-inline-code-background"),
    ).toContain("color-mix");
    expect(
      tooltipElement()
        .querySelector<HTMLElement>(".editor-typescript-lsp-hover-markdown")
        ?.style.getPropertyValue("--editor-typescript-lsp-hover-code-block-background"),
    ).toContain("color-mix");
  });

  it("caps long hover tooltip content and keeps the body scrollable", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const context = viewContributionContext(editorSnapshot());
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);
    mockElementRect(tooltipElement(), new DOMRect(0, 0, 180, 900));

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 12, clientY: 16, buttons: 0 }),
    );
    await vi.advanceTimersByTimeAsync(260);

    const hoverRequest = message(worker.sent.toReversed().find(hasMethod("textDocument/hover")));
    worker.receive({
      jsonrpc: "2.0",
      id: hoverRequest.id,
      result: {
        contents: {
          kind: "markdown",
          value: Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join("\n\n"),
        },
      },
    });
    await flushPromises();

    expect(tooltipElement().hidden).toBe(false);
    expect(tooltipElement().style.maxHeight).toBe("420px");
    expect(tooltipElement().style.overflow).toBe("hidden");
    expect(tooltipBody()?.style.overflowY).toBe("auto");
    expect(tooltipBody()?.style.minHeight).toBe("0");
  });

  it("jumps to same-file definitions from the current selection", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({
        selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
      }),
    );
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(context) as
      | (ReturnType<EditorViewContributionProvider["createContribution"]> & {
          goToDefinitionFromSelection(): boolean;
        })
      | null;
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    expect(contribution.goToDefinitionFromSelection()).toBe(true);

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod("textDocument/definition")),
    );
    worker.receive({
      jsonrpc: "2.0",
      id: definitionRequest.id,
      result: [
        {
          uri: "file:///src/index.ts",
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        },
      ],
    });
    await flushPromises();

    expect(context.setSelection).toHaveBeenCalledWith(6, 11, "typescriptLsp.goToDefinition", 6);
  });

  it("underlines jumpable symbols while hovering with a navigation modifier", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({ text: "const source = value; const value = 1;" }),
    );
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(15);
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 12,
        clientY: 16,
        ctrlKey: true,
      }),
    );

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod("textDocument/definition")),
    );
    expect(definitionRequest.params).toMatchObject({
      textDocument: { uri: "file:///src/index.ts" },
      position: { line: 0, character: 15 },
    });

    worker.receive({
      jsonrpc: "2.0",
      id: definitionRequest.id,
      result: [
        {
          uri: "file:///src/index.ts",
          range: {
            start: { line: 0, character: 28 },
            end: { line: 0, character: 33 },
          },
        },
      ],
    });
    await flushPromises();

    expect(context.setRangeHighlight).toHaveBeenCalledWith(
      "editor-test-typescript-lsp-definition-link",
      [{ start: 15, end: 20 }],
      expect.objectContaining({
        color: "#60a5fa",
        textDecoration: expect.stringContaining("underline"),
      }),
    );
    expect(context.scrollElement.style.cursor).toBe("pointer");

    context.scrollElement.dispatchEvent(new PointerEvent("pointerleave"));
    expect(context.clearRangeHighlight).toHaveBeenCalledWith(
      "editor-test-typescript-lsp-definition-link",
    );
    expect(context.scrollElement.style.cursor).toBe("");
  });

  it("keeps hover tooltip working while hovering with a navigation modifier", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({ text: "const source = value; const value = 1;" }),
    );
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(15);
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 12,
        clientY: 16,
        ctrlKey: true,
      }),
    );

    expect(worker.sent.some(hasMethod("textDocument/definition"))).toBe(true);
    await vi.advanceTimersByTimeAsync(260);
    const hoverRequest = message(worker.sent.toReversed().find(hasMethod("textDocument/hover")));
    expect(hoverRequest.params).toMatchObject({
      textDocument: { uri: "file:///src/index.ts" },
      position: { line: 0, character: 15 },
    });

    worker.receive({
      jsonrpc: "2.0",
      id: hoverRequest.id,
      result: {
        contents: { kind: "markdown", value: "```ts\nconst value: number\n```" },
        range: {
          start: { line: 0, character: 15 },
          end: { line: 0, character: 20 },
        },
      },
    });
    await flushPromises();

    expect(tooltipElement().hidden).toBe(false);
    expect(tooltipElement().querySelector("pre > code")?.textContent).toBe("const value: number");
  });

  it("does not underline a symbol when its definition is the same range", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const context = viewContributionContext(editorSnapshot());
    vi.mocked(context.textOffsetFromPoint).mockReturnValue(6);
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const provider = activatePlugin(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    context.scrollElement.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: 12,
        clientY: 16,
        ctrlKey: true,
      }),
    );

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod("textDocument/definition")),
    );
    worker.receive({
      jsonrpc: "2.0",
      id: definitionRequest.id,
      result: [
        {
          uri: "file:///src/index.ts",
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        },
      ],
    });
    await flushPromises();

    expect(context.setRangeHighlight).not.toHaveBeenCalledWith(
      "editor-test-typescript-lsp-definition-link",
      expect.anything(),
      expect.anything(),
    );
    expect(context.clearRangeHighlight).toHaveBeenCalledWith(
      "editor-test-typescript-lsp-definition-link",
    );
    expect(context.scrollElement.style.cursor).toBe("");
  });

  it("reports cross-file definitions through the open callback", async () => {
    const worker = new FakeWorker();
    const openDefinition = vi.fn();
    const plugin = createTypeScriptLspPlugin({
      workerFactory: () => worker,
      onOpenDefinition: openDefinition,
    });
    const provider = activatePlugin(plugin);
    const contribution = provider.createContribution(
      viewContributionContext(
        editorSnapshot({
          selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
        }),
      ),
    ) as
      | (ReturnType<EditorViewContributionProvider["createContribution"]> & {
          goToDefinitionFromSelection(): boolean;
        })
      | null;
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    expect(contribution.goToDefinitionFromSelection()).toBe(true);

    const definitionRequest = message(
      worker.sent.toReversed().find(hasMethod("textDocument/definition")),
    );
    worker.receive({
      jsonrpc: "2.0",
      id: definitionRequest.id,
      result: [
        {
          uri: "file:///src/other.ts",
          range: {
            start: { line: 1, character: 7 },
            end: { line: 1, character: 12 },
          },
        },
      ],
    });
    await flushPromises();

    expect(openDefinition).toHaveBeenCalledWith({
      uri: "file:///src/other.ts",
      path: "src/other.ts",
      range: {
        start: { line: 1, character: 7 },
        end: { line: 1, character: 12 },
      },
    });
  });

  it("registers VS Code navigation and marker commands at plugin level", () => {
    const plugin = createTypeScriptLspPlugin();
    const { commands } = activatePluginWithCommands(plugin);

    expect([...commands.keys()]).toEqual(
      expect.arrayContaining([
        "goToDefinition",
        "editor.action.goToDefinition",
        "editor.action.goToReferences",
        "editor.action.peekDefinition",
        "editor.action.revealDefinitionAside",
        "editor.action.goToImplementation",
        "editor.action.goToTypeDefinition",
        "editor.action.marker.next",
        "editor.action.marker.prev",
      ]),
    );
  });

  it("requests completions while typing and accepts the selected suggestion", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const container = document.createElement("div");
    const applyEdits = vi.fn<EditorFeatureContributionContext["applyEdits"]>();
    const { provider, features } = activatePluginWithCommands(
      createTypeScriptLspPlugin({ workerFactory: () => worker }),
      { container, applyEdits },
    );
    const context = viewContributionContext(
      editorSnapshot({
        text: "const va",
        selections: [collapsedSelection(8)],
      }),
      { container, features },
    );
    const contribution = provider.createContribution(context);
    if (!contribution) throw new Error("missing contribution");

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    contribution.update(
      editorSnapshot({
        text: "const val",
        textVersion: 2,
        selections: [collapsedSelection(9)],
      }),
      "content",
      documentChange([{ from: 8, to: 8, text: "l" }]),
    );
    await vi.advanceTimersByTimeAsync(90);

    const request = message(worker.sent.toReversed().find(hasMethod("textDocument/completion")));
    expect(request.params).toMatchObject({
      textDocument: { uri: "file:///src/index.ts" },
      position: { line: 0, character: 9 },
      context: { triggerKind: 1 },
    });

    worker.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        isIncomplete: false,
        items: [
          {
            label: "value",
            kind: 6,
            labelDetails: { description: ": number" },
            textEdit: {
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 9 },
              },
              newText: "value",
            },
          },
        ],
      },
    });
    await flushPromises();

    expect(completionElement().hidden).toBe(false);
    expect(completionElement().textContent).toContain("value");

    context.scrollElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    expect(applyEdits).toHaveBeenCalledWith(
      [{ from: 6, to: 9, text: "value" }],
      "typescriptLsp.completion.accept",
      { anchor: 11, head: 11 },
    );
    expect(completionElement().hidden).toBe(true);
  });

  it("routes implementation commands through the TypeScript LSP plugin", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({
        selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
      }),
    );
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const { provider, commands } = activatePluginWithCommands(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    expect(command(commands, "editor.action.goToImplementation")({})).toBe(true);

    const request = message(
      worker.sent.toReversed().find(hasMethod("textDocument/implementation")),
    );
    worker.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: [
        {
          uri: "file:///src/index.ts",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
        },
      ],
    });
    await flushPromises();

    expect(context.setSelection).toHaveBeenCalledWith(0, 5, "typescriptLsp.goToImplementation", 0);
  });

  it("routes references commands and jumps to the next same-file reference", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({
        text: "const value = 1; console.log(value);",
        selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
      }),
    );
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const { provider, commands } = activatePluginWithCommands(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    expect(command(commands, "editor.action.goToReferences")({})).toBe(true);

    const request = message(worker.sent.toReversed().find(hasMethod("textDocument/references")));
    expect(request.params).toMatchObject({
      textDocument: { uri: "file:///src/index.ts" },
      position: { line: 0, character: 6 },
      context: { includeDeclaration: true },
    });

    worker.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: [
        {
          uri: "file:///src/index.ts",
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        },
        {
          uri: "file:///src/index.ts",
          range: {
            start: { line: 0, character: 29 },
            end: { line: 0, character: 34 },
          },
        },
      ],
    });
    await flushPromises();

    expect(context.setSelection).toHaveBeenCalledWith(29, 34, "typescriptLsp.goToReferences", 29);
  });

  it("moves next and previous marker commands across TypeScript diagnostics", async () => {
    const worker = new FakeWorker();
    const context = viewContributionContext(
      editorSnapshot({
        selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
      }),
    );
    const plugin = createTypeScriptLspPlugin({ workerFactory: () => worker });
    const { provider, commands } = activatePluginWithCommands(plugin);
    provider.createContribution(context);

    worker.receive(initializeResponse(message(worker.sent[0])));
    await flushPromises();
    worker.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///src/index.ts",
        version: 0,
        diagnostics: [
          {
            severity: 1,
            source: "typescript",
            message: "first",
            range: {
              start: { line: 0, character: 2 },
              end: { line: 0, character: 3 },
            },
          },
          {
            severity: 1,
            source: "typescript",
            message: "second",
            range: {
              start: { line: 0, character: 22 },
              end: { line: 0, character: 23 },
            },
          },
        ],
      },
    });

    expect(command(commands, "editor.action.marker.next")({})).toBe(true);
    expect(context.setSelection).toHaveBeenCalledWith(22, 23, "typescriptLsp.marker.next", 22);

    expect(command(commands, "editor.action.marker.prev")({})).toBe(true);
    expect(context.setSelection).toHaveBeenCalledWith(2, 3, "typescriptLsp.marker.previous", 2);
  });
});

function activatePlugin(
  plugin: ReturnType<typeof createTypeScriptLspPlugin>,
): EditorViewContributionProvider {
  let provider: EditorViewContributionProvider | null = null;
  plugin.activate({
    registerHighlighter: () => ({ dispose: () => undefined }),
    registerSyntaxProvider: () => ({ dispose: () => undefined }),
    registerViewContribution: (value) => {
      provider = value;
      return { dispose: () => undefined };
    },
    registerEditorFeatureContribution: () => ({ dispose: () => undefined }),
    registerGutterContribution: () => ({ dispose: () => undefined }),
    registerBlockProvider: () => ({ dispose: () => undefined }),
    registerInjectedTextRowProvider: () => ({ dispose: () => undefined }),
  } satisfies EditorPluginContext);

  if (!provider) throw new Error("missing provider");
  return provider;
}

function activatePluginWithCommands(
  plugin: ReturnType<typeof createTypeScriptLspPlugin>,
  options?: FeatureContributionContextOptions,
): {
  readonly provider: EditorViewContributionProvider;
  readonly commands: ReadonlyMap<EditorCommandId, EditorCommandHandler>;
  readonly features: ReadonlyMap<string, unknown>;
};
function activatePluginWithCommands(
  plugin: ReturnType<typeof createTypeScriptLspPlugin>,
  options?: FeatureContributionContextOptions,
): {
  readonly provider: EditorViewContributionProvider;
  readonly commands: ReadonlyMap<EditorCommandId, EditorCommandHandler>;
  readonly features: ReadonlyMap<string, unknown>;
} {
  let provider: EditorViewContributionProvider | null = null;
  const commands = new Map<EditorCommandId, EditorCommandHandler>();
  const features = options?.features ?? new Map<string, unknown>();
  plugin.activate({
    registerHighlighter: () => ({ dispose: () => undefined }),
    registerSyntaxProvider: () => ({ dispose: () => undefined }),
    registerViewContribution: (value) => {
      provider = value;
      return { dispose: () => undefined };
    },
    registerEditorFeatureContribution: (value) => {
      value.createContribution(featureContributionContext(commands, { ...options, features }));
      return { dispose: () => undefined };
    },
    registerGutterContribution: () => ({ dispose: () => undefined }),
    registerBlockProvider: () => ({ dispose: () => undefined }),
    registerInjectedTextRowProvider: () => ({ dispose: () => undefined }),
  } satisfies EditorPluginContext);

  if (!provider) throw new Error("missing provider");
  return { provider, commands, features };
}

type FeatureContributionContextOptions = {
  readonly container?: HTMLDivElement;
  readonly features?: Map<string, unknown>;
  readonly applyEdits?: EditorFeatureContributionContext["applyEdits"];
};

function featureContributionContext(
  commands: Map<EditorCommandId, EditorCommandHandler>,
  options: FeatureContributionContextOptions = {},
): EditorFeatureContributionContext {
  const element = options.container ?? document.createElement("div");
  return {
    container: element,
    scrollElement: element,
    highlightPrefix: "editor-test",
    hasDocument: () => true,
    getText: () => "",
    getSelections: () => [],
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setSelections: vi.fn(),
    applyEdits: options.applyEdits ?? vi.fn(),
    setRangeHighlight: vi.fn(),
    clearRangeHighlight: vi.fn(),
    setRowDecorations: vi.fn(),
    clearRowDecorations: vi.fn(),
    registerCommand: (commandId, handler) => {
      commands.set(commandId, handler);
      return { dispose: () => commands.delete(commandId) };
    },
    registerFeature: (id, feature) => {
      options.features?.set(id, feature);
      return { dispose: () => options.features?.delete(id) };
    },
  };
}

function command(
  commands: ReadonlyMap<EditorCommandId, EditorCommandHandler>,
  commandId: EditorCommandId,
): EditorCommandHandler {
  const handler = commands.get(commandId);
  if (!handler) throw new Error(`missing command ${commandId}`);
  return handler;
}

function viewContributionContext(
  snapshot: EditorViewSnapshot,
  options: {
    readonly container?: HTMLDivElement;
    readonly features?: ReadonlyMap<string, unknown>;
  } = {},
): EditorViewContributionContext {
  const element = options.container ?? document.createElement("div");
  const getFeature = vi.fn((id: string): unknown | null => {
    const feature = options.features?.get(id);
    return feature === undefined ? null : feature;
  }) as EditorViewContributionContext["getFeature"];
  return {
    container: element,
    scrollElement: element,
    highlightPrefix: "editor-test",
    getSnapshot: () => snapshot,
    getFeature,
    revealLine: vi.fn(),
    focusEditor: vi.fn(),
    setSelection: vi.fn(),
    setScrollTop: vi.fn(),
    reserveOverlayWidth: vi.fn(),
    textOffsetFromPoint: vi.fn(() => 22),
    getRangeClientRect: vi.fn(() => new DOMRect(10, 20, 40, 18)),
    setRangeHighlight: vi.fn(),
    clearRangeHighlight: vi.fn(),
  };
}

function minimapFeature(): EditorMinimapFeature {
  return {
    setDecorations: vi.fn(),
    clearDecorations: vi.fn(),
    getDecorations: vi.fn(() => []),
    subscribe: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function editorSnapshot(options: Partial<EditorViewSnapshot> = {}): EditorViewSnapshot {
  const text = options.text ?? "const value: string = 1;";
  return {
    documentId: "src/index.ts",
    languageId: "typescript",
    text,
    textVersion: 1,
    lineStarts: [0],
    tokens: [],
    selections: [],
    metrics: {} as EditorViewSnapshot["metrics"],
    lineCount: 1,
    contentWidth: 0,
    totalHeight: 0,
    tabSize: 4,
    foldMarkers: [],
    visibleRows: [],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 0,
      scrollWidth: 0,
      clientHeight: 0,
      clientWidth: 0,
      visibleRange: { start: 0, end: 1 } as EditorViewSnapshot["viewport"]["visibleRange"],
    },
    ...options,
  };
}

function collapsedSelection(offset: number): EditorViewSnapshot["selections"][number] {
  return {
    anchorOffset: offset,
    headOffset: offset,
    startOffset: offset,
    endOffset: offset,
  };
}

function documentChange(edits: readonly TextEdit[]): DocumentSessionChange {
  return {
    kind: "edit",
    edits,
    text: "",
    tokens: [],
    timings: [],
    canUndo: false,
    canRedo: false,
  } as unknown as DocumentSessionChange;
}

function initializeResponse(request: JsonMessage): JsonMessage {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 2,
        },
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: ["."],
        },
      },
    },
  };
}

function publishDiagnosticsMessage(
  options: {
    readonly range?: {
      readonly start: { readonly line: number; readonly character: number };
      readonly end: { readonly line: number; readonly character: number };
    };
  } = {},
): JsonMessage {
  return {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: "file:///src/index.ts",
      version: 0,
      diagnostics: [
        {
          severity: 1,
          source: "typescript",
          message: "bad assignment",
          range: options.range ?? {
            start: { line: 0, character: 22 },
            end: { line: 0, character: 23 },
          },
        },
      ],
    },
  };
}

function sentMethods(worker: FakeWorker): readonly unknown[] {
  return worker.sent.map((item) => message(item).method);
}

function sentSocketMethods(socket: FakeWebSocket): readonly unknown[] {
  return socket.sent.map((item) => jsonMessage(item).method);
}

function textDocumentFor(item: unknown): unknown {
  const params = message(item).params as { readonly textDocument: unknown };
  return params.textDocument;
}

function latestRangeHighlightRanges(
  context: EditorViewContributionContext,
  name: string,
): readonly { readonly start: number; readonly end: number }[] {
  const calls = vi.mocked(context.setRangeHighlight!).mock.calls;
  for (const call of calls.toReversed()) {
    if (call[0] === name) return call[1];
  }

  throw new Error(`Missing range highlight call: ${name}`);
}

function tooltipElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".editor-typescript-lsp-hover");
  if (!element) throw new Error("missing tooltip");
  return element;
}

function tooltipAnchorElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".editor-typescript-lsp-hover-anchor");
  if (!element) throw new Error("missing tooltip anchor");
  return element;
}

function tooltipBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".editor-typescript-lsp-hover-body");
}

function copyButton(): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(".editor-typescript-lsp-hover-copy");
  if (!element) throw new Error("missing copy button");
  return element;
}

function completionElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".editor-typescript-lsp-completion");
  if (!element) throw new Error("missing completion widget");
  return element;
}

function mockElementRect(element: HTMLElement, rect: DOMRect): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

function message(item: unknown): JsonMessage {
  if (!isRecord(item)) throw new Error("missing message");
  return item;
}

function jsonMessage(item: unknown): JsonMessage {
  if (typeof item !== "string") throw new Error("missing JSON message");
  return JSON.parse(item) as JsonMessage;
}

function hasMethod(method: string): (item: unknown) => boolean {
  return (item) => message(item).method === method;
}

function hasSocketMethod(method: string): (item: unknown) => boolean {
  return (item) => typeof item === "string" && jsonMessage(item).method === method;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
