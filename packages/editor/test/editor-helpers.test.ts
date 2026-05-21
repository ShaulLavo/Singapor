import { describe, expect, it, vi } from "vitest";
import type { EditorOptions, HighlightRegistry } from "../src/editor/types";
import {
  childContainingNode,
  childNodeIndex,
  elementBoundaryToTextOffset,
} from "../src/editor/domBoundary";
import { EditorFoldState } from "../src/editor/foldState";
import {
  defaultEditorKeyBindings,
  editorKeyBindings,
  editorKeymapLayersForCommandPacks,
  readonlySafeEditorCommandPacks,
} from "../src/editor/keymap";
import {
  foldMarkerFromRange,
  foldRangeKey,
  foldRangesEqual,
  projectSyntaxFoldsThroughLineEdit,
} from "../src/editor/folds";
import { mouseSelectionAutoScrollDelta } from "../src/editor/mouseSelection";
import { nextWordOffset, previousWordOffset } from "../src/editor/navigation";
import { lineRangeAtOffset, wordRangeAtOffset } from "../src/editor/textRanges";
import { appendTiming, eventStartMs, mergeChangeTimings } from "../src/editor/timing";
import { createDocumentSession, type DocumentSessionChange } from "../src/documentSession";
import {
  projectTokensThroughEdit,
  tokenProjectionLiveRangeStatus,
} from "../src/editor/tokenProjection";
import {
  appendEditorTokenIndexEntry,
  createEditorTokenIndexBuilder,
  finishEditorTokenIndex,
  getEditorTokenIndex,
} from "../src/editor/tokenIndex";
import type { TextSnapshot } from "../src/documentTextSnapshot";
import { createPieceTableSnapshot } from "../src/pieceTable/pieceTable";
import type { FoldRange } from "../src/syntax";
import type { EditorToken } from "../src/tokens";

describe("editor DOM boundary helpers", () => {
  it("maps element boundaries and child nodes to text positions", () => {
    const parent = document.createElement("div");
    const first = document.createElement("span");
    const second = document.createElement("span");
    const nested = document.createElement("strong");
    second.appendChild(nested);
    parent.append(first, second);

    expect(elementBoundaryToTextOffset(-1, 10)).toBe(0);
    expect(elementBoundaryToTextOffset(1, 10)).toBe(10);
    expect(childContainingNode(parent, nested)).toBe(second);
    expect(childNodeIndex(parent, second)).toBe(1);
  });
});

describe("editor fold helpers", () => {
  it("creates stable marker keys and compares fold ranges", () => {
    const fold = foldRange({ startIndex: 4, endIndex: 20, startLine: 1, endLine: 5 });

    expect(foldRangeKey(fold)).toBe("typescript:block:4:20");
    expect(foldMarkerFromRange(fold, new Set([foldRangeKey(fold)]))).toMatchObject({
      key: "typescript:block:4:20",
      startOffset: 4,
      endOffset: 20,
      collapsed: true,
    });
    expect(foldRangesEqual([fold], [{ ...fold }])).toBe(true);
    expect(foldRangesEqual([fold], [{ ...fold, endLine: 6 }])).toBe(false);
  });

  it("projects folds through line edits and records key remaps", () => {
    const fold = foldRange({ startIndex: 10, endIndex: 30, startLine: 2, endLine: 6 });
    const projection = projectSyntaxFoldsThroughLineEdit(
      [fold],
      { from: 0, to: 0, text: "a\n" },
      "function f() {\n  return 1;\n}\n",
    );

    expect(projection?.folds[0]).toMatchObject({
      startIndex: 12,
      endIndex: 32,
      startLine: 3,
      endLine: 7,
    });
    expect(projection?.keyMap.get(foldRangeKey(fold))).toBe("typescript:block:12:32");
  });

  it("projects folds from snapshot ranges without materializing full text", () => {
    const fold = foldRange({ startIndex: 9, endIndex: 18, startLine: 3, endLine: 5 });
    const projection = projectSyntaxFoldsThroughLineEdit(
      [fold],
      { from: 0, to: 6, text: "x" },
      lazyTextSnapshot("aa\nbb\ncc\ndd\nee\n"),
    );

    expect(projection?.folds[0]).toMatchObject({
      startIndex: 4,
      startLine: 1,
    });
  });
});

describe("EditorFoldState", () => {
  it("syncs markers and remaps collapsed fold keys through projections", () => {
    const setFoldState = vi.fn();
    const state = new EditorFoldState({ setFoldState }, () =>
      createPieceTableSnapshot("function f() {\n  return 1;\n}\n"),
    );
    const fold = foldRange({ startIndex: 0, endIndex: 28, startLine: 0, endLine: 2 });

    state.setSyntaxFolds([fold]);
    state.toggle(foldMarkerFromRange(fold, new Set()));
    state.applyProjection({
      folds: [{ ...fold, startIndex: 2, endIndex: 30, startLine: 1, endLine: 3 }],
      keyMap: new Map([[foldRangeKey(fold), "typescript:block:2:30"]]),
    });

    const [markers, foldMap] = setFoldState.mock.lastCall ?? [];
    expect(markers?.[0]).toMatchObject({ key: "typescript:block:2:30", collapsed: true });
    expect(foldMap).not.toBeNull();
  });
});

describe("mouse selection helpers", () => {
  it("returns signed auto-scroll deltas near the vertical edges", () => {
    const rect = { top: 100, bottom: 300, height: 200 } as DOMRect;

    expect(mouseSelectionAutoScrollDelta(99, rect)).toBeLessThan(0);
    expect(mouseSelectionAutoScrollDelta(301, rect)).toBeGreaterThan(0);
    expect(mouseSelectionAutoScrollDelta(200, rect)).toBe(0);
  });
});

describe("navigation helpers", () => {
  it("moves by word boundaries without splitting surrogate pairs", () => {
    const text = "alpha 😀 beta";

    expect(nextWordOffset(text, 0)).toBe(6);
    expect(nextWordOffset(text, 6)).toBe(9);
    expect(previousWordOffset(text, text.length)).toBe(9);
  });
});

describe("default editor keybindings", () => {
  it("resolves later layers over earlier layers for the same normalized hotkey", () => {
    const bindings = editorKeyBindings({
      defaultBindings: false,
      layers: [
        {
          id: "base",
          bindings: [{ hotkey: "Mod+K", command: "find" }],
        },
        {
          id: "override",
          bindings: [{ hotkey: { key: "K", mod: true }, command: "selectAll" }],
        },
      ],
    });

    expect(bindings).toEqual([{ hotkey: { key: "K", mod: true }, command: "selectAll" }]);
  });

  it("builds readonly-safe command pack layers without edit commands", () => {
    const commands = editorKeymapLayersForCommandPacks(readonlySafeEditorCommandPacks, "linux")
      .flatMap((layer) => layer.bindings)
      .map((binding) => binding.command);

    expect(commands).toContain("cursorLeft");
    expect(commands).toContain("selectAll");
    expect(commands).toContain("find");
    expect(commands).not.toContain("deleteBackward");
    expect(commands).not.toContain("findReplace");
    expect(commands).not.toContain("editor.action.insertCursorAbove");
    expect(commands).not.toContain("goToDefinition");
  });

  it("binds VS Code edit actions by default", () => {
    const commands = defaultEditorKeyBindings("mac").map((binding) => binding.command);

    expect(commands).toContain("deleteWordLeft");
    expect(commands).toContain("deleteWordRight");
    expect(commands).toContain("editor.action.commentLine");
    expect(commands).toContain("editor.action.blockComment");
    expect(commands).toContain("editor.action.indentLines");
    expect(commands).toContain("editor.action.outdentLines");
    expect(commands).toContain("editor.action.deleteLines");
    expect(commands).toContain("editor.action.copyLinesUpAction");
    expect(commands).toContain("editor.action.copyLinesDownAction");
    expect(commands).toContain("editor.action.moveLinesUpAction");
    expect(commands).toContain("editor.action.moveLinesDownAction");
    expect(commands).toContain("editor.action.insertLineBefore");
    expect(commands).toContain("editor.action.insertLineAfter");
  });

  it("binds VS Code multi-cursor actions without chord-only commands", () => {
    const commands = defaultEditorKeyBindings("linux").map((binding) => binding.command);

    expect(commands).toContain("editor.action.insertCursorAbove");
    expect(commands).toContain("editor.action.insertCursorBelow");
    expect(commands).toContain("editor.action.selectHighlights");
    expect(commands).toContain("editor.action.changeAll");
    expect(commands).not.toContain("editor.action.moveSelectionToNextFindMatch");
  });

  it("uses VS Code platform-specific edit shortcut shapes", () => {
    expect(defaultEditorKeyBindings("mac")).toContainEqual(
      expect.objectContaining({
        command: "deleteWordLeft",
        hotkey: expect.objectContaining({ alt: true, key: "Backspace" }),
      }),
    );
    expect(defaultEditorKeyBindings("linux")).toContainEqual(
      expect.objectContaining({
        command: "editor.action.copyLinesUpAction",
        hotkey: expect.objectContaining({
          alt: true,
          key: "ArrowUp",
          mod: true,
          shift: true,
        }),
      }),
    );
    expect(defaultEditorKeyBindings("windows")).toContainEqual(
      expect.objectContaining({
        command: "editor.action.blockComment",
        hotkey: expect.objectContaining({ alt: true, key: "A", shift: true }),
      }),
    );
  });
});

describe("text range helpers", () => {
  it("finds line and word ranges at clamped offsets", () => {
    const text = "one two\nthree";

    expect(lineRangeAtOffset(text, 5)).toEqual({ start: 0, end: 7 });
    expect(lineRangeAtOffset(text, 99)).toEqual({ start: 8, end: 13 });
    expect(wordRangeAtOffset(text, 4)).toEqual({ start: 4, end: 7 });
    expect(wordRangeAtOffset(text, 7)).toEqual({ start: 4, end: 7 });
  });
});

describe("timing helpers", () => {
  it("appends and merges timing measurements", () => {
    const change = createEmptyChange();
    const withTiming = appendTiming(change, "apply", eventStartMs(new Event("input")));
    const merged = mergeChangeTimings(
      { ...change, timings: [{ name: "render", durationMs: 1 }] },
      withTiming,
    );

    expect(withTiming.timings[0]?.name).toBe("apply");
    expect(merged.timings.map((timing) => timing.name)).toEqual(["apply", "render"]);
  });
});

function createEmptyChange(): DocumentSessionChange {
  return { ...createDocumentSession("a").applyText(""), timings: [] };
}

describe("token projection", () => {
  it("shifts, expands, and drops tokens across edits", () => {
    const style = { color: "red" };
    const tokens = [
      { start: 0, end: 5, style },
      { start: 6, end: 10, style },
      { start: 11, end: 16, style },
    ];

    expect(
      projectTokensThroughEdit(tokens, { from: 5, to: 5, text: "Name" }, "alpha beta gamma"),
    ).toEqual([
      { start: 0, end: 9, style },
      { start: 10, end: 14, style },
      { start: 15, end: 20, style },
    ]);
    expect(
      projectTokensThroughEdit(tokens, { from: 7, to: 9, text: "\n" }, "alpha beta gamma"),
    ).toEqual([
      { start: 0, end: 5, style },
      { start: 10, end: 15, style },
    ]);
  });

  it("records whether projected tokens can keep live ranges", () => {
    const style = { color: "red" };
    const tokens = indexedTokens([
      { start: 0, end: 5, style },
      { start: 6, end: 10, style },
    ]);

    const shifted = projectTokensThroughEdit(tokens, { from: 5, to: 5, text: "X" }, "alpha beta");
    const dropped = projectTokensThroughEdit(tokens, { from: 7, to: 9, text: "\n" }, "alpha beta");

    expect(tokenProjectionLiveRangeStatus(tokens, shifted)).toBe(true);
    expect(tokenProjectionLiveRangeStatus(tokens, dropped)).toBe(false);
    expect(tokenProjectionLiveRangeStatus([], shifted)).toBe(false);
  });

  it("bulk-projects monotonic indexed token insertions, deletions, and replacements", () => {
    const style = { color: "red" };
    const base = [
      { start: 0, end: 5, style },
      { start: 6, end: 10, style },
      { start: 11, end: 16, style },
    ];

    const inserted = projectTokensThroughEdit(
      indexedTokens(base),
      { from: 5, to: 5, text: "Name" },
      "alpha beta gamma",
    );
    expect(inserted).toEqual([
      { start: 0, end: 9, style },
      { start: 10, end: 14, style },
      { start: 15, end: 20, style },
    ]);
    expect(getEditorTokenIndex(inserted)).toMatchObject({
      maxEnds: [9, 14, 20],
      monotonicEnd: true,
      nonOverlapping: true,
      sortedByStart: true,
    });

    const deleted = projectTokensThroughEdit(
      indexedTokens(base),
      { from: 7, to: 9, text: "" },
      "alpha beta gamma",
    );
    expect(deleted).toEqual([
      { start: 0, end: 5, style },
      { start: 6, end: 8, style },
      { start: 9, end: 14, style },
    ]);
    expect(getEditorTokenIndex(deleted)?.maxEnds).toEqual([5, 8, 14]);

    const replaced = projectTokensThroughEdit(
      indexedTokens(base),
      { from: 7, to: 9, text: "ZZ" },
      "alpha beta gamma",
    );
    expect(replaced).toEqual(base);
    expect(getEditorTokenIndex(replaced)?.maxEnds).toEqual([5, 10, 16]);
  });

  it("uses the indexed bulk path for large unchanged suffixes", () => {
    const style = { color: "red" };
    const text = "a ".repeat(1_000);
    const tokens = indexedTokens(
      Array.from({ length: 1_000 }, (_, index) => ({
        start: index * 2,
        end: index * 2 + 1,
        style,
      })),
    );

    const diagnostics = collectPerformanceDiagnostics(() => {
      const projected = projectTokensThroughEdit(tokens, { from: 1, to: 1, text: "X" }, text);
      expect(projected).toHaveLength(1_000);
    });

    expect(diagnostics.find(tokenProjectionPath)?.detail).toMatchObject({
      path: "indexed.bulk",
      suffixCount: 999,
      tokenCount: 1_000,
    });
  });

  it("bulk-projects overlapping tokens when their ends stay monotonic", () => {
    const style = { color: "red" };
    const tokens = indexedTokens([
      { start: 0, end: 5, style },
      { start: 0, end: 5, style },
      { start: 6, end: 10, style },
    ]);

    const diagnostics = collectPerformanceDiagnostics(() => {
      const projected = projectTokensThroughEdit(
        tokens,
        { from: 5, to: 5, text: "Name" },
        "alpha beta",
      );
      expect(projected).toEqual([
        { start: 0, end: 9, style },
        { start: 0, end: 9, style },
        { start: 10, end: 14, style },
      ]);
      expect(getEditorTokenIndex(projected)).toMatchObject({
        maxEnds: [9, 9, 14],
        monotonicEnd: true,
        nonOverlapping: false,
        sortedByStart: true,
      });
    });

    expect(diagnostics.find(tokenProjectionPath)?.detail).toMatchObject({
      monotonicEnd: true,
      nonOverlapping: false,
      path: "indexed.bulk",
    });
  });

  it("bulk-projects non-monotonic overlapping indexed tokens and preserves exact maxEnds", () => {
    const style = { color: "red" };
    const tokens = indexedTokens([
      { start: 0, end: 10, style },
      { start: 2, end: 5, style },
      { start: 11, end: 15, style },
    ]);

    const diagnostics = collectPerformanceDiagnostics(() => {
      const projected = projectTokensThroughEdit(
        tokens,
        { from: 10, to: 10, text: "." },
        "abcdefghij klmn",
      );
      expect(projected).toEqual([
        { start: 0, end: 10, style },
        { start: 2, end: 5, style },
        { start: 12, end: 16, style },
      ]);
      expect(getEditorTokenIndex(projected)).toMatchObject({
        maxEnds: [10, 10, 16],
        monotonicEnd: false,
        nonOverlapping: false,
        sortedByStart: true,
      });
    });

    expect(diagnostics.find(tokenProjectionPath)?.detail).toMatchObject({
      monotonicEnd: false,
      path: "indexed.bulk",
    });
  });

  it("uses snapshot ranges for token word-boundary checks", () => {
    const style = { color: "red" };
    const tokens = [{ start: 0, end: 5, style }];
    const projected = projectTokensThroughEdit(
      tokens,
      { from: 5, to: 5, text: "Name" },
      lazyTextSnapshot("alpha beta"),
    );

    expect(projected).toEqual([{ start: 0, end: 9, style }]);
  });

  it("reads only tiny snapshot ranges for token word-boundary checks", () => {
    const style = { color: "red" };
    const reads: Array<readonly [number, number]> = [];
    const projected = projectTokensThroughEdit(
      indexedTokens([{ start: 0, end: 5, style }]),
      { from: 5, to: 5, text: "Name" },
      recordingTextSnapshot("alpha beta", reads),
    );

    expect(projected).toEqual([{ start: 0, end: 9, style }]);
    expect(reads.every(([start, end]) => end - start <= 2)).toBe(true);
  });

  it("handles snapshot-backed surrogate-pair word-boundary checks", () => {
    const style = { color: "red" };
    const text = "😀alpha";
    const tokens = [{ start: 2, end: 7, style }];
    const projected = projectTokensThroughEdit(
      tokens,
      { from: 2, to: 2, text: "X" },
      lazyTextSnapshot(text),
    );

    expect(projected).toEqual([{ start: 2, end: 8, style }]);
  });
});

function lazyTextSnapshot(text: string): TextSnapshot {
  return {
    length: text.length,
    getText: () => {
      throw new Error("unexpected full text materialization");
    },
    getTextInRange: (start, end) => text.slice(start, end),
    forEachTextChunk: (visit) => {
      if (text.length > 0) visit(text, 0, text.length);
    },
  };
}

function recordingTextSnapshot(
  text: string,
  reads: Array<readonly [number, number]>,
): TextSnapshot {
  return {
    length: text.length,
    getText: () => {
      throw new Error("unexpected full text materialization");
    },
    getTextInRange: (start, end = text.length) => {
      reads.push([start, end]);
      return text.slice(start, end);
    },
    forEachTextChunk: (visit) => {
      if (text.length > 0) visit(text, 0, text.length);
    },
  };
}

function indexedTokens(tokens: readonly EditorToken[]): readonly EditorToken[] {
  const indexed = [...tokens];
  const builder = createEditorTokenIndexBuilder();
  for (const token of indexed) appendEditorTokenIndexEntry(builder, token);
  finishEditorTokenIndex(indexed, builder);
  return indexed;
}

type TestPerformanceDiagnostic = {
  readonly name: string;
  readonly detail?: Readonly<Record<string, unknown>>;
};

function collectPerformanceDiagnostics(run: () => void): readonly TestPerformanceDiagnostic[] {
  const global = globalThis as typeof globalThis & {
    __EDITOR_PERFORMANCE_DIAGNOSTICS__?: unknown;
  };
  const previous = global.__EDITOR_PERFORMANCE_DIAGNOSTICS__;
  const diagnostics: TestPerformanceDiagnostic[] = [];
  global.__EDITOR_PERFORMANCE_DIAGNOSTICS__ = {
    record: (diagnostic: TestPerformanceDiagnostic) => diagnostics.push(diagnostic),
  };

  try {
    run();
  } finally {
    global.__EDITOR_PERFORMANCE_DIAGNOSTICS__ = previous;
  }

  return diagnostics;
}

function tokenProjectionPath(diagnostic: TestPerformanceDiagnostic): boolean {
  return diagnostic.name === "editor.tokenProjection.path";
}

describe("editor public helper types", () => {
  it("keeps public option and highlight registry contracts assignable", () => {
    const registry: HighlightRegistry = {
      set: vi.fn(),
      delete: vi.fn(() => true),
    };
    const options: EditorOptions = { plugins: [], keymap: {}, onChange: vi.fn() };

    registry.set("editor-test", {} as Highlight);
    expect(options.plugins).toEqual([]);
    expect(registry.delete("editor-test")).toBe(true);
  });
});

function foldRange(overrides: Partial<FoldRange> = {}): FoldRange {
  return {
    startIndex: 0,
    endIndex: 10,
    startLine: 0,
    endLine: 1,
    type: "block",
    languageId: "typescript",
    ...overrides,
  };
}
