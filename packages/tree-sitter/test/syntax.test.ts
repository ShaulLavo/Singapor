import { describe, expect, expectTypeOf, it } from "vitest";

import {
  applyBatchToPieceTable,
  createDocumentSession,
  createPieceTableSnapshot,
  EditorPluginHost,
  styleForTreeSitterCapture,
  treeSitterCapturesToEditorTokens,
} from "@editor/core";
import {
  createTreeSitterLanguagePlugin,
  resolveTreeSitterLanguageAlias,
  resolveTreeSitterLanguageContribution,
  TreeSitterLanguageRegistry,
  type TreeSitterLanguageContribution,
} from "../src";
import {
  createTextDiffEdit,
  createTreeSitterEditPayload,
  TreeSitterSyntaxSession,
} from "../src/session";
import { createTreeSitterSourceDescriptor } from "../src/treeSitter/source";
import type {
  TreeSitterEditRequest,
  TreeSitterParseRequest,
  TreeSitterParseResult,
} from "../src/treeSitter/types";
import type { TreeSitterBackend, TreeSitterEditPayload } from "../src/treeSitter/workerClient";

describe("Tree-sitter syntax capture conversion", () => {
  it("maps known capture names to editor token styles", () => {
    expect(styleForTreeSitterCapture("keyword.declaration")).toEqual({
      color: "var(--editor-syntax-keyword-declaration)",
    });
    expect(styleForTreeSitterCapture("string")).toEqual({
      color: "var(--editor-syntax-string)",
    });
    expect(styleForTreeSitterCapture("constructor")).toEqual({
      color: "var(--editor-syntax-type-definition)",
    });
    expect(styleForTreeSitterCapture("text.title")).toEqual({
      color: "var(--editor-syntax-keyword-declaration)",
      fontWeight: 700,
    });
    expect(styleForTreeSitterCapture("text.uri")).toEqual({
      color: "var(--editor-syntax-string)",
      textDecoration: "underline",
    });
    expect(styleForTreeSitterCapture("unknown.scope")).toBeNull();
  });

  it("resolves registered aliases and descriptors", async () => {
    const registry = createTestLanguageRegistry();
    const descriptor = await registry.resolveTreeSitterLanguage("ts");

    expect(descriptor).toMatchObject({
      id: "typescript",
      wasmUrl: "/typescript.wasm",
      extensions: [".ts", ".cts", ".mts", ".tsx"],
      aliases: ["typescript", "ts", "tsx"],
      highlightQuerySource: "(identifier) @variable",
    });
    expect(resolveTreeSitterLanguageAlias("js", registry)).toBe("javascript");
    expect(resolveTreeSitterLanguageAlias("css", registry)).toBeNull();
    expect(resolveTreeSitterLanguageAlias("sql", registry)).toBeNull();
  });

  it("supports async language asset loaders", async () => {
    const descriptor = await resolveTreeSitterLanguageContribution({
      id: "rust",
      extensions: ["rs"],
      aliases: ["rust"],
      load: async () => ({
        wasmUrl: "/rust.wasm",
        highlightQuerySource: "(identifier) @variable",
      }),
    });

    expect(descriptor).toMatchObject({
      id: "rust",
      extensions: [".rs"],
      aliases: ["rust"],
      wasmUrl: "/rust.wasm",
    });
  });

  it("rejects duplicate language ids unless replacement is explicit", async () => {
    const registry = new TreeSitterLanguageRegistry();
    const original = registry.registerLanguage(testLanguage("typescript", [".ts"]));

    expect(() => registry.registerLanguage(testLanguage("typescript", [".tsx"]))).toThrow(
      /already registered/,
    );

    const replacement = registry.registerLanguage(testLanguage("typescript", [".mts"]), {
      replace: true,
    });
    await expect(registry.resolveTreeSitterLanguage("typescript")).resolves.toMatchObject({
      extensions: [".mts"],
    });

    replacement.dispose();
    await expect(registry.resolveTreeSitterLanguage("typescript")).resolves.toMatchObject({
      extensions: [".ts"],
    });

    original.dispose();
    await expect(registry.resolveTreeSitterLanguage("typescript")).resolves.toBeNull();
  });

  it("registers language contributions through editor plugins", () => {
    const host = new EditorPluginHost([
      createTreeSitterLanguagePlugin([testLanguage("sql", [".sql"])], { name: "sql-language" }),
    ]);
    const snapshot = createPieceTableSnapshot("select 1;");

    expect(
      host.createSyntaxSession({
        documentId: "query.sql",
        languageId: "sql",
        includeHighlights: true,
        text: "select 1;",
        snapshot,
      }),
    ).not.toBeNull();

    host.dispose();

    expect(
      host.createSyntaxSession({
        documentId: "query.sql",
        languageId: "sql",
        includeHighlights: true,
        text: "select 1;",
        snapshot,
      }),
    ).toBeNull();
  });

  it("shares language plugin registrations across editor plugin hosts", () => {
    const plugin = createTreeSitterLanguagePlugin([testLanguage("sql", [".sql"])], {
      name: "sql-language",
    });
    const firstHost = new EditorPluginHost([plugin]);
    const secondHost = new EditorPluginHost([plugin]);

    expect(createSqlSyntaxSession(firstHost)).not.toBeNull();
    expect(createSqlSyntaxSession(secondHost)).not.toBeNull();

    firstHost.dispose();

    expect(createSqlSyntaxSession(secondHost)).not.toBeNull();

    secondHost.dispose();

    const emptyHost = new EditorPluginHost([]);
    expect(createSqlSyntaxSession(emptyHost)).toBeNull();
    emptyHost.dispose();

    const nextHost = new EditorPluginHost([plugin]);
    expect(createSqlSyntaxSession(nextHost)).not.toBeNull();
    nextHost.dispose();
  });

  it("converts non-empty captures to editor tokens", () => {
    const tokens = treeSitterCapturesToEditorTokens([
      { startIndex: 0, endIndex: 5, captureName: "keyword.declaration" },
      { startIndex: 6, endIndex: 6, captureName: "string" },
      { startIndex: 7, endIndex: 10, captureName: "not.mapped" },
    ]);

    expect(tokens).toEqual([
      {
        start: 0,
        end: 5,
        style: { color: "var(--editor-syntax-keyword-declaration)" },
      },
    ]);
  });

  it("builds single-edit payloads for incremental reparsing", () => {
    const previousSnapshot = createPieceTableSnapshot("const a = 1;\n");
    const edits = [{ from: 6, to: 7, text: "answer" }];
    const nextSnapshot = applyBatchToPieceTable(previousSnapshot, edits);
    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      previousSnapshot,
      nextSnapshot,
      edits,
    });

    expect(payload).toMatchObject({
      documentId: "file.ts",
      snapshotVersion: 2,
      languageId: "typescript",
      inputEdits: [
        {
          startIndex: 6,
          oldEndIndex: 7,
          newEndIndex: 12,
          startPosition: { row: 0, column: 6 },
          oldEndPosition: { row: 0, column: 7 },
          newEndPosition: { row: 0, column: 12 },
        },
      ],
    });
  });

  it("keeps worker parse and edit requests source-based", () => {
    const snapshot = createPieceTableSnapshot("const a = 1;\n");
    const source = createTreeSitterSourceDescriptor(snapshot, { useSharedBuffers: false });
    const parseRequest: TreeSitterParseRequest = {
      type: "parse",
      documentId: "file.ts",
      snapshotVersion: 1,
      languageId: "typescript",
      includeHighlights: true,
      source,
      generation: 1,
    };
    const editRequest: TreeSitterEditRequest = {
      type: "edit",
      documentId: "file.ts",
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      languageId: "typescript",
      includeHighlights: true,
      source,
      edits: [],
      inputEdits: [],
      generation: 2,
    };

    expect("source" in parseRequest).toBe(true);
    expect("snapshot" in parseRequest).toBe(false);
    expect("text" in parseRequest).toBe(false);
    expect("source" in editRequest).toBe(true);
    expect("snapshot" in editRequest).toBe(false);
    expect("text" in editRequest).toBe(false);
    expectTypeOf<"snapshot">().not.toMatchTypeOf<keyof TreeSitterParseRequest>();
    expectTypeOf<"text">().not.toMatchTypeOf<keyof TreeSitterParseRequest>();
    expectTypeOf<"snapshot">().not.toMatchTypeOf<keyof TreeSitterEditRequest>();
    expectTypeOf<"text">().not.toMatchTypeOf<keyof TreeSitterEditRequest>();
  });

  it("builds incremental payloads for multi-edits", () => {
    const previousSnapshot = createPieceTableSnapshot("ab\ncd");
    const edits = [
      { from: 0, to: 1, text: "x" },
      { from: 3, to: 5, text: "yz" },
    ];
    const nextSnapshot = applyBatchToPieceTable(previousSnapshot, edits);
    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      previousSnapshot,
      nextSnapshot,
      edits,
    });

    expect(payload?.inputEdits).toMatchObject([
      {
        startIndex: 3,
        oldEndIndex: 5,
        newEndIndex: 5,
        startPosition: { row: 1, column: 0 },
        oldEndPosition: { row: 1, column: 2 },
        newEndPosition: { row: 1, column: 2 },
      },
      {
        startIndex: 0,
        oldEndIndex: 1,
        newEndIndex: 1,
        startPosition: { row: 0, column: 0 },
        oldEndPosition: { row: 0, column: 1 },
        newEndPosition: { row: 0, column: 1 },
      },
    ]);
  });

  it("diffs skipped typing edits against the cached syntax text", () => {
    const previousText = "const a = 1;";
    const nextText = "const a = 1;!?";
    const previousSnapshot = createPieceTableSnapshot(previousText);
    const nextSnapshot = createPieceTableSnapshot(nextText);
    const edit = createTextDiffEdit(previousText, nextText);

    expect(edit).toEqual({ from: 12, to: 12, text: "!?" });

    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      previousSnapshotVersion: 1,
      snapshotVersion: 2,
      previousSnapshot,
      nextSnapshot,
      edits: edit ? [edit] : [],
    });

    expect(payload?.inputEdits).toMatchObject([
      {
        startIndex: 12,
        oldEndIndex: 12,
        newEndIndex: 14,
        startPosition: { row: 0, column: 12 },
        oldEndPosition: { row: 0, column: 12 },
        newEndPosition: { row: 0, column: 14 },
      },
    ]);
  });

  it("reuses document change edits when they apply to the cached syntax snapshot", async () => {
    const backend = createCapturingTreeSitterBackend();
    const text = "const a = 1;";
    const document = createDocumentSession(text);
    const session = new TreeSitterSyntaxSession({
      backend,
      documentId: "file.ts",
      languageId: "typescript",
      snapshot: document.getSnapshot(),
      text,
    });
    const change = document.applyEdits([
      { from: text.length, text: "\nconst b = 2;", to: text.length },
    ]);

    await session.applyChange(change);

    expect(backend.latestEdit?.edits).toEqual([
      { from: text.length, text: "\nconst b = 2;", to: text.length },
    ]);
  });

  it("falls back to a cached-text diff when document edits do not apply", async () => {
    const backend = createCapturingTreeSitterBackend();
    const session = new TreeSitterSyntaxSession({
      backend,
      documentId: "file.ts",
      languageId: "typescript",
      snapshot: createPieceTableSnapshot("abc"),
      text: "abc",
    });
    const staleDocument = createDocumentSession("abc!");
    const change = staleDocument.applyEdits([{ from: 4, text: "?", to: 4 }]);

    await session.applyChange(change);

    expect(backend.latestEdit?.edits).toEqual([{ from: 3, text: "!?", to: 3 }]);
  });

  it("targets incremental edits at the parsed snapshot version", async () => {
    const { backend, edits } = createDeferredTreeSitterBackend();
    const initialText = "const a = 1;";
    const document = createDocumentSession(initialText);
    const session = new TreeSitterSyntaxSession({
      backend,
      documentId: "file.ts",
      languageId: "typescript",
      snapshot: document.getSnapshot(),
      text: initialText,
    });

    await session.refresh(document.getSnapshot(), document.getText());

    const firstChange = document.applyEdits([
      { from: initialText.length, text: "!", to: initialText.length },
    ]);
    const firstPromise = session.applyChange(firstChange);
    const secondChange = document.applyEdits([
      { from: firstChange.text.length, text: "?", to: firstChange.text.length },
    ]);
    const secondPromise = session.applyChange(secondChange);
    await Promise.resolve();

    expect(edits.map(({ payload }) => payload.previousSnapshotVersion)).toEqual([1, 1]);
    expect(edits.map(({ payload }) => payload.snapshotVersion)).toEqual([2, 3]);
    expect(edits[1]?.payload.edits).toEqual([
      { from: initialText.length, text: "!?", to: initialText.length },
    ]);

    const firstEdit = edits[0]!;
    firstEdit.result.resolve(createParseResult(firstEdit.payload));
    await firstPromise;
    const secondEdit = edits[1]!;
    secondEdit.result.resolve(createParseResult(secondEdit.payload));
    await secondPromise;

    const currentText = document.getText();
    const thirdChange = document.applyEdits([
      { from: currentText.length, text: ";", to: currentText.length },
    ]);
    const thirdPromise = session.applyChange(thirdChange);
    await Promise.resolve();

    expect(edits[2]?.payload.previousSnapshotVersion).toBe(3);

    const thirdEdit = edits[2]!;
    thirdEdit.result.resolve(createParseResult(thirdEdit.payload));
    await thirdPromise;
  });

  it("falls back to a full refresh when incremental parsing fails", async () => {
    const parseVersions: number[] = [];
    const disposedDocuments: string[] = [];
    const backend = {
      disposeDocument: (documentId) => {
        disposedDocuments.push(documentId);
      },
      edit: async () => {
        throw new Error("incremental parse failed");
      },
      parse: async (payload) => {
        parseVersions.push(payload.snapshotVersion);
        return createParseResult(payload);
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend;
    const initialText = "const a = 1;";
    const document = createDocumentSession(initialText);
    const session = new TreeSitterSyntaxSession({
      backend,
      documentId: "file.ts",
      languageId: "typescript",
      snapshot: document.getSnapshot(),
      text: initialText,
    });

    await session.refresh(document.getSnapshot(), document.getText());
    const change = document.applyEdits([
      { from: initialText.length, text: "\nconst b = 2;", to: initialText.length },
    ]);
    const result = await session.applyChange(change);

    expect(parseVersions).toEqual([1, 3]);
    expect(disposedDocuments).toEqual(["file.ts"]);
    expect(session.getSnapshotVersion()).toBe(3);
    expect(session.getResult()).toBe(result);
  });

  it("falls back to a full refresh when current incremental parsing is cancelled", async () => {
    const parseVersions: number[] = [];
    const disposedDocuments: string[] = [];
    const backend = {
      disposeDocument: (documentId) => {
        disposedDocuments.push(documentId);
      },
      edit: async () => undefined,
      parse: async (payload) => {
        parseVersions.push(payload.snapshotVersion);
        return createParseResult(payload);
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend;
    const initialText = "const a = 1;";
    const document = createDocumentSession(initialText);
    const session = new TreeSitterSyntaxSession({
      backend,
      documentId: "file.ts",
      languageId: "typescript",
      snapshot: document.getSnapshot(),
      text: initialText,
    });

    await session.refresh(document.getSnapshot(), document.getText());
    const change = document.applyEdits([
      { from: initialText.length, text: "\nconst b = 2;", to: initialText.length },
    ]);
    const result = await session.applyChange(change);

    expect(parseVersions).toEqual([1, 3]);
    expect(disposedDocuments).toEqual(["file.ts"]);
    expect(session.getSnapshotVersion()).toBe(3);
    expect(session.getResult()).toBe(result);
  });

  it("does not run stale incremental fallbacks after a newer edit starts", async () => {
    const parseVersions: number[] = [];
    const disposedDocuments: string[] = [];
    const edits: { payload: TreeSitterEditPayload; result: Deferred<TreeSitterParseResult> }[] = [];
    const backend = {
      disposeDocument: (documentId) => {
        disposedDocuments.push(documentId);
      },
      edit: (payload: TreeSitterEditPayload) => {
        const result = createDeferred<TreeSitterParseResult>();
        edits.push({ payload, result });
        return result.promise;
      },
      parse: async (payload) => {
        parseVersions.push(payload.snapshotVersion);
        return createParseResult(payload);
      },
      registerLanguages: async () => undefined,
      select: async () => undefined,
    } satisfies TreeSitterBackend;
    const initialText = "const a = 1;";
    const document = createDocumentSession(initialText);
    const session = new TreeSitterSyntaxSession({
      backend,
      documentId: "file.ts",
      languageId: "typescript",
      snapshot: document.getSnapshot(),
      text: initialText,
    });

    await session.refresh(document.getSnapshot(), document.getText());
    const firstChange = document.applyEdits([
      { from: initialText.length, text: "!", to: initialText.length },
    ]);
    const firstPromise = session.applyChange(firstChange);
    const secondChange = document.applyEdits([
      { from: firstChange.text.length, text: "?", to: firstChange.text.length },
    ]);
    const secondPromise = session.applyChange(secondChange);
    await Promise.resolve();

    edits[0]?.result.reject(new Error("stale incremental parse failed"));
    await firstPromise;
    const secondEdit = edits[1]!;
    secondEdit.result.resolve(createParseResult(secondEdit.payload));
    await secondPromise;

    expect(parseVersions).toEqual([1]);
    expect(disposedDocuments).toEqual([]);
    expect(session.getSnapshotVersion()).toBe(3);
  });
});

function createCapturingTreeSitterBackend() {
  const backend = {
    latestEdit: null as TreeSitterEditPayload | null,
    disposeDocument: () => undefined,
    edit: async (payload: TreeSitterEditPayload) => {
      backend.latestEdit = payload;
      return {
        brackets: [],
        captures: [],
        documentId: payload.documentId,
        errors: [],
        folds: [],
        injections: [],
        languageId: payload.languageId,
        snapshotVersion: payload.snapshotVersion,
        timings: [],
      };
    },
    parse: async () => undefined,
    registerLanguages: async () => undefined,
    select: async () => undefined,
  } satisfies TreeSitterBackend & { latestEdit: TreeSitterEditPayload | null };

  return backend;
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDeferredTreeSitterBackend() {
  const edits: { payload: TreeSitterEditPayload; result: Deferred<TreeSitterParseResult> }[] = [];
  const backend = {
    disposeDocument: () => undefined,
    edit: (payload: TreeSitterEditPayload) => {
      const result = createDeferred<TreeSitterParseResult>();
      edits.push({ payload, result });
      return result.promise;
    },
    parse: async (payload) => createParseResult(payload),
    registerLanguages: async () => undefined,
    select: async () => undefined,
  } satisfies TreeSitterBackend;

  return { backend, edits };
}

function createParseResult(payload: {
  readonly documentId: string;
  readonly languageId: string;
  readonly snapshotVersion: number;
}): TreeSitterParseResult {
  return {
    brackets: [],
    captures: [],
    documentId: payload.documentId,
    errors: [],
    folds: [],
    injections: [],
    languageId: payload.languageId,
    snapshotVersion: payload.snapshotVersion,
    timings: [],
  };
}

function createTestLanguageRegistry(): TreeSitterLanguageRegistry {
  const registry = new TreeSitterLanguageRegistry();
  registry.registerLanguage(
    testLanguage("javascript", [".js", ".cjs", ".jsx", ".mjs"], ["javascript", "js", "jsx"]),
  );
  registry.registerLanguage(
    testLanguage("typescript", [".ts", ".cts", ".mts", ".tsx"], ["typescript", "ts", "tsx"]),
  );
  return registry;
}

function createSqlSyntaxSession(host: EditorPluginHost) {
  const text = "select 1;";
  return host.createSyntaxSession({
    documentId: "query.sql",
    languageId: "sql",
    includeHighlights: true,
    text,
    snapshot: createPieceTableSnapshot(text),
  });
}

function testLanguage(
  id: string,
  extensions: readonly string[],
  aliases: readonly string[] = [id],
): TreeSitterLanguageContribution {
  return {
    id,
    extensions,
    aliases,
    wasmUrl: `/${id}.wasm`,
    highlightQuerySource: "(identifier) @variable",
  };
}
