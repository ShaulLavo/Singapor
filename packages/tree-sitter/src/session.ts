import {
  applyBatchToPieceTable,
  createDocumentTextSnapshot,
  documentSessionChangeTextSnapshot,
  offsetToPoint,
  pieceTableSnapshotsHaveSameText,
  treeSitterCapturesToEditorTokens,
  type DocumentSessionChange,
  type DocumentTextSnapshot,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  type PieceTableSnapshot,
  type TextEdit,
} from "@editor/core";
import type {
  TreeSitterInputEdit,
  TreeSitterLanguageId,
  TreeSitterParseResult,
} from "./treeSitter/types";
import type { TreeSitterLanguageResolver } from "./treeSitter/registry";
import {
  createTreeSitterWorkerBackend,
  type TreeSitterBackend,
  type TreeSitterEditPayload,
} from "./treeSitter/workerClient";

export type TreeSitterSyntaxSessionOptions = {
  readonly documentId: string;
  readonly languageId: TreeSitterLanguageId;
  readonly languageResolver?: TreeSitterLanguageResolver;
  readonly includeHighlights?: boolean;
  readonly text?: string;
  readonly textSnapshot?: DocumentTextSnapshot;
  readonly snapshot: PieceTableSnapshot;
  readonly backend?: TreeSitterBackend;
};

export class TreeSitterSyntaxSession implements EditorSyntaxSession {
  private readonly documentId: string;
  private readonly languageId: TreeSitterLanguageId;
  private readonly languageResolver: TreeSitterLanguageResolver | undefined;
  private readonly includeHighlights: boolean;
  private readonly backend: TreeSitterBackend;
  private snapshotVersion = 0;
  private parsedSnapshotVersion = 0;
  private textSnapshot: DocumentTextSnapshot;
  private snapshot: PieceTableSnapshot;
  private result: EditorSyntaxResult = createEmptySyntaxResult();
  private languageRegistrationPromise: Promise<boolean> | null = null;

  public constructor(options: TreeSitterSyntaxSessionOptions) {
    this.documentId = options.documentId;
    this.languageId = options.languageId;
    this.languageResolver = options.languageResolver;
    this.includeHighlights = options.includeHighlights ?? true;
    this.textSnapshot =
      options.textSnapshot ?? createDocumentTextSnapshot(options.snapshot, options.text);
    this.snapshot = options.snapshot;
    this.backend = options.backend ?? createTreeSitterWorkerBackend();
  }

  public async refresh(snapshot: PieceTableSnapshot, text?: string): Promise<EditorSyntaxResult> {
    const snapshotVersion = ++this.snapshotVersion;
    const textSnapshot = createDocumentTextSnapshot(snapshot, text);
    this.debug("refresh start", {
      snapshotLength: snapshot.length,
      snapshotVersion,
      textProvided: text !== undefined,
    });

    try {
      if (!(await this.ensureLanguageRegistered())) {
        this.debug("refresh language unavailable", { snapshotVersion });
        return this.updateFromUnavailableLanguage(textSnapshot, snapshot);
      }

      const result = await this.backend.parse({
        documentId: this.documentId,
        snapshotVersion,
        languageId: this.languageId,
        includeHighlights: this.includeHighlights,
        snapshot,
      });
      this.debug("refresh result", {
        resultVersion: result?.snapshotVersion ?? null,
        snapshotVersion,
        ...treeSitterResultDebugInfo(result),
      });

      return this.updateFromTreeSitterResult(result, snapshotVersion, textSnapshot, snapshot);
    } catch (error) {
      this.warn(`refresh failed: ${treeSitterErrorMessage(error)}`, {
        error: treeSitterDebugError(error),
        snapshotVersion,
      });
      throw error;
    }
  }

  public async applyChange(change: DocumentSessionChange): Promise<EditorSyntaxResult> {
    this.debug("edit start", {
      changeKind: change.kind,
      nextLength: change.snapshot.length,
      parsedSnapshotVersion: this.parsedSnapshotVersion,
      previousLength: this.snapshot.length,
      snapshotVersion: this.snapshotVersion,
    });
    if (change.kind === "none" || change.kind === "selection") {
      this.debug("edit skipped", { changeKind: change.kind });
      return this.result;
    }

    if (!(await this.ensureLanguageRegistered())) {
      this.snapshotVersion += 1;
      this.debug("edit language unavailable", {
        snapshotVersion: this.snapshotVersion,
      });
      return this.updateFromUnavailableLanguage(
        documentSessionChangeTextSnapshot(change),
        change.snapshot,
      );
    }

    const edits = createSyntaxTextEdits(this.textSnapshot, this.snapshot, change);
    if (edits.length === 0) {
      this.debug("edit skipped unchanged text", {
        changeKind: change.kind,
        snapshotVersion: this.snapshotVersion,
      });
      this.textSnapshot = documentSessionChangeTextSnapshot(change);
      this.snapshot = change.snapshot;
      return this.result;
    }

    const payload = createTreeSitterEditPayload({
      documentId: this.documentId,
      languageId: this.languageId,
      previousSnapshotVersion: this.parsedSnapshotVersion,
      snapshotVersion: ++this.snapshotVersion,
      previousSnapshot: this.snapshot,
      nextSnapshot: change.snapshot,
      edits,
      includeHighlights: this.includeHighlights,
    });

    this.debug("edit payload", {
      editCount: edits.length,
      inputEditCount: payload?.inputEdits.length ?? 0,
      previousSnapshotVersion: this.parsedSnapshotVersion,
      snapshotVersion: this.snapshotVersion,
    });
    if (!payload) {
      this.debug("edit falling back to refresh without payload", {
        snapshotVersion: this.snapshotVersion,
      });
      return this.refresh(change.snapshot);
    }

    return this.applyIncrementalEdit(payload, documentSessionChangeTextSnapshot(change));
  }

  public getResult(): EditorSyntaxResult {
    return this.result;
  }

  public getTokens(): readonly EditorSyntaxResult["tokens"][number][] {
    return this.result.tokens;
  }

  public getSnapshotVersion(): number {
    return this.snapshotVersion;
  }

  public dispose(): void {
    this.backend.disposeDocument(this.documentId);
  }

  private async applyIncrementalEdit(
    payload: TreeSitterEditPayload,
    nextTextSnapshot: DocumentTextSnapshot,
  ): Promise<EditorSyntaxResult> {
    try {
      const result = await this.backend.edit(payload);
      if (!this.isCurrentSnapshotVersion(payload.snapshotVersion)) {
        this.debug("edit result ignored as stale", {
          currentSnapshotVersion: this.snapshotVersion,
          resultVersion: result?.snapshotVersion ?? null,
          snapshotVersion: payload.snapshotVersion,
        });
        return this.result;
      }

      if (!result || result.snapshotVersion !== payload.snapshotVersion) {
        this.warn("edit result requires full reparse", {
          resultVersion: result?.snapshotVersion ?? null,
          snapshotVersion: payload.snapshotVersion,
          ...treeSitterResultDebugInfo(result),
        });
        return this.reparseAfterIncrementalFailure(payload.snapshot);
      }

      this.debug("edit result", {
        snapshotVersion: payload.snapshotVersion,
        ...treeSitterResultDebugInfo(result),
      });
      return this.updateFromTreeSitterResult(
        result,
        payload.snapshotVersion,
        nextTextSnapshot,
        payload.snapshot,
      );
    } catch (error) {
      if (!this.isCurrentSnapshotVersion(payload.snapshotVersion)) {
        this.debug("edit failure ignored as stale", {
          currentSnapshotVersion: this.snapshotVersion,
          error: treeSitterDebugError(error),
          snapshotVersion: payload.snapshotVersion,
        });
        return this.result;
      }

      this.warn(`edit failed: ${treeSitterErrorMessage(error)}`, {
        error: treeSitterDebugError(error),
        snapshotVersion: payload.snapshotVersion,
      });
      return this.reparseAfterIncrementalFailure(payload.snapshot);
    }
  }

  private reparseAfterIncrementalFailure(
    snapshot: PieceTableSnapshot,
  ): Promise<EditorSyntaxResult> {
    this.warn("dispose worker document before recovery reparse", {
      snapshotLength: snapshot.length,
      snapshotVersion: this.snapshotVersion,
    });
    this.backend.disposeDocument(this.documentId);
    return this.refresh(snapshot);
  }

  private debug(message: string, payload: TreeSitterSessionDebugPayload = {}): void {
    logTreeSitterSessionDebug(message, {
      documentId: this.documentId,
      includeHighlights: this.includeHighlights,
      languageId: this.languageId,
      parsedSnapshotVersion: this.parsedSnapshotVersion,
      snapshotVersion: this.snapshotVersion,
      ...payload,
    });
  }

  private warn(message: string, payload: TreeSitterSessionDebugPayload = {}): void {
    warnTreeSitterSession(message, {
      documentId: this.documentId,
      includeHighlights: this.includeHighlights,
      languageId: this.languageId,
      parsedSnapshotVersion: this.parsedSnapshotVersion,
      snapshotVersion: this.snapshotVersion,
      ...payload,
    });
  }

  private isCurrentSnapshotVersion(snapshotVersion: number): boolean {
    return snapshotVersion === this.snapshotVersion;
  }

  private ensureLanguageRegistered(): Promise<boolean> {
    if (!this.languageResolver) return Promise.resolve(true);
    if (!this.languageRegistrationPromise) {
      this.languageRegistrationPromise = this.registerResolvedLanguage();
    }

    return this.languageRegistrationPromise;
  }

  private async registerResolvedLanguage(): Promise<boolean> {
    const descriptor = await this.languageResolver?.resolveTreeSitterLanguage(this.languageId);
    if (!descriptor) return false;

    await this.backend.registerLanguages([descriptor]);
    return true;
  }

  private updateFromUnavailableLanguage(
    textSnapshot: DocumentTextSnapshot,
    snapshot: PieceTableSnapshot,
  ): EditorSyntaxResult {
    this.textSnapshot = textSnapshot;
    this.snapshot = snapshot;
    this.result = createEmptySyntaxResult();
    return this.result;
  }

  private updateFromTreeSitterResult(
    result: TreeSitterParseResult | undefined,
    snapshotVersion: number,
    textSnapshot: DocumentTextSnapshot,
    snapshot: PieceTableSnapshot,
  ): EditorSyntaxResult {
    if (!result) return this.result;
    if (result.snapshotVersion !== snapshotVersion) return this.result;
    if (result.snapshotVersion !== this.snapshotVersion) return this.result;

    this.textSnapshot = textSnapshot;
    this.snapshot = snapshot;
    this.parsedSnapshotVersion = result.snapshotVersion;
    this.result = treeSitterParseResultToEditorSyntaxResult(result);
    return this.result;
  }
}

type TreeSitterEditPayloadOptions = {
  readonly documentId: string;
  readonly languageId: TreeSitterLanguageId;
  readonly previousSnapshotVersion: number;
  readonly snapshotVersion: number;
  readonly previousSnapshot: PieceTableSnapshot;
  readonly nextSnapshot: PieceTableSnapshot;
  readonly edits: readonly TextEdit[];
  readonly includeHighlights?: boolean;
};

export const createTreeSitterEditPayload = (
  options: TreeSitterEditPayloadOptions,
): TreeSitterEditPayload | null => {
  if (options.edits.length === 0) return null;

  return {
    documentId: options.documentId,
    previousSnapshotVersion: options.previousSnapshotVersion,
    snapshotVersion: options.snapshotVersion,
    languageId: options.languageId,
    includeHighlights: options.includeHighlights ?? true,
    snapshot: options.nextSnapshot,
    edits: options.edits,
    inputEdits: createTreeSitterInputEdits(options.previousSnapshot, options.edits),
  };
};

export const createTextDiffEdit = (previousText: string, nextText: string): TextEdit | null => {
  if (previousText === nextText) return null;

  let start = 0;
  const maxPrefixLength = Math.min(previousText.length, nextText.length);
  while (start < maxPrefixLength && previousText[start] === nextText[start]) start += 1;

  let previousEnd = previousText.length;
  let nextEnd = nextText.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    from: start,
    to: previousEnd,
    text: nextText.slice(start, nextEnd),
  };
};

const createSyntaxTextEdits = (
  previousTextSnapshot: DocumentTextSnapshot,
  previousSnapshot: PieceTableSnapshot,
  change: DocumentSessionChange,
): readonly TextEdit[] => {
  if (changeEditsApplyToSnapshot(previousSnapshot, change)) return change.edits;

  const edit = createTextDiffEdit(
    previousTextSnapshot.getText(),
    documentSessionChangeTextSnapshot(change).getText(),
  );
  return edit ? [edit] : [];
};

const changeEditsApplyToSnapshot = (
  snapshot: PieceTableSnapshot,
  change: DocumentSessionChange,
): boolean => {
  try {
    return pieceTableSnapshotsHaveSameText(
      applyBatchToPieceTable(snapshot, change.edits),
      change.snapshot,
    );
  } catch {
    return false;
  }
};

const treeSitterParseResultToEditorSyntaxResult = (
  result: TreeSitterParseResult,
): EditorSyntaxResult => ({
  captures: result.captures,
  folds: result.folds,
  brackets: result.brackets,
  errors: result.errors,
  injections: result.injections,
  tokens: treeSitterCapturesToEditorTokens(result.captures),
});

const createEmptySyntaxResult = (): EditorSyntaxResult => ({
  captures: [],
  folds: [],
  brackets: [],
  errors: [],
  injections: [],
  tokens: [],
});

const createTreeSitterInputEdits = (
  snapshot: PieceTableSnapshot,
  edits: readonly TextEdit[],
): TreeSitterInputEdit[] => {
  const sorted = edits.toSorted((left, right) => right.from - left.from || right.to - left.to);
  const inputEdits: TreeSitterInputEdit[] = [];
  let workingSnapshot = snapshot;

  for (const edit of sorted) {
    const startPosition = offsetToPoint(workingSnapshot, edit.from);
    const oldEndPosition = offsetToPoint(workingSnapshot, edit.to);
    const nextSnapshot = applyBatchToPieceTable(workingSnapshot, [edit]);
    const newEndIndex = edit.from + edit.text.length;

    inputEdits.push({
      startIndex: edit.from,
      oldEndIndex: edit.to,
      newEndIndex,
      startPosition,
      oldEndPosition,
      newEndPosition: offsetToPoint(nextSnapshot, newEndIndex),
    });
    workingSnapshot = nextSnapshot;
  }

  return inputEdits;
};

type TreeSitterSessionDebugPayload = Record<string, unknown>;

const logTreeSitterSessionDebug = (
  message: string,
  payload: TreeSitterSessionDebugPayload,
): void => {
  if (!isTreeSitterSessionDebugEnabled()) return;

  logTreeSitterSessionDebugEnabled();
  console.info(`[editor-syntax:tree-sitter-session] ${message}`, payload);
};

const warnTreeSitterSession = (message: string, payload: TreeSitterSessionDebugPayload): void => {
  console.warn(`[editor-syntax:tree-sitter-session] ${message}`, payload);
};

let treeSitterSessionDebugEnabledLogged = false;

const logTreeSitterSessionDebugEnabled = (): void => {
  if (treeSitterSessionDebugEnabledLogged) return;

  treeSitterSessionDebugEnabledLogged = true;
  console.info("[editor-syntax:tree-sitter-session] debug enabled");
};

const isTreeSitterSessionDebugEnabled = (): boolean => {
  const scope = globalThis as typeof globalThis & {
    readonly __EDITOR_SYNTAX_DEBUG__?: unknown;
    readonly localStorage?: { getItem(key: string): string | null };
  };
  if (scope.__EDITOR_SYNTAX_DEBUG__) return true;

  try {
    return scope.localStorage?.getItem("editorSyntaxDebug") === "1";
  } catch {
    return false;
  }
};

const treeSitterResultDebugInfo = (
  result: TreeSitterParseResult | undefined,
): TreeSitterSessionDebugPayload => {
  if (!result) return { result: null };

  return {
    brackets: result.brackets.length,
    captures: result.captures.length,
    errors: result.errors.length,
    folds: result.folds.length,
    injections: result.injections.length,
    timings: result.timings,
  };
};

const treeSitterDebugError = (error: unknown): TreeSitterSessionDebugPayload => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { value: String(error) };
};

const treeSitterErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};
