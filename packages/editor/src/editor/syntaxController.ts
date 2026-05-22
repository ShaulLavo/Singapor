import type { DocumentSession, DocumentSessionChange } from "../documentSession";
import { defineLazyTextProperty, type DocumentTextSnapshot } from "../documentTextSnapshot";
import type { PieceTableSnapshot } from "../pieceTable/pieceTableTypes";
import type { EditorHighlightResult, EditorHighlighterSession, EditorPluginHost } from "../plugins";
import { createEmptySyntaxResult } from "../syntax/session";
import type { EditorSyntaxRange, EditorSyntaxResult, EditorSyntaxSession } from "../syntax/session";
import type { EditorSyntaxLanguageId, FoldRange } from "../syntax/session";
import type { EditorTheme } from "../theme";
import { editorThemesEqual } from "../theme";
import type { EditorToken } from "../tokens";
import {
  appendEditorTokenIndexEntry,
  createEditorTokenIndexBuilder,
  finishEditorTokenIndex,
} from "./tokenIndex";
import { LatestAsyncRequest } from "./latestAsyncRequest";
import { getEditorSyntaxSessionFactory } from "./runtime";
import { syntaxRefreshDelay } from "./editorUtils";
import { appendTiming } from "./timing";

export type EditorSyntaxDocumentStartOptions = {
  readonly documentId: string;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly snapshot: PieceTableSnapshot;
  readonly textSnapshot: DocumentTextSnapshot;
};

export type EditorSyntaxControllerOptions = {
  readonly pluginHost: EditorPluginHost;
  getDocumentVersion(): number;
  getCurrentSessionDocumentId(): string;
  getLanguageId(): EditorSyntaxLanguageId | null;
  getSession(): DocumentSession | null;
  getVisibleSyntaxRange(): EditorSyntaxRange | null;
  adoptTokens(tokens: readonly EditorToken[]): void;
  clearSyntaxFolds(): void;
  setSyntaxFolds(folds: readonly FoldRange[]): void;
  notifyChange(change: DocumentSessionChange | null): void;
  notifyThemeChanged(): void;
};

export type EditorSyntaxRefreshOptions = {
  readonly delayMs?: number;
  readonly range?: EditorSyntaxRange | null;
};

type EditorSyntaxLoadResult = {
  readonly range: EditorSyntaxRange | null;
  readonly result: EditorSyntaxResult;
  readonly skipApply?: boolean;
};

type PendingSyntaxPrefetch = {
  readonly documentVersion: number;
  readonly options: EditorSyntaxRefreshOptions;
  readonly range: EditorSyntaxRange;
};

type PendingSyntaxWarm = {
  readonly delayMs: number;
  readonly documentVersion: number;
  readonly generation: number;
  readonly seedRange: EditorSyntaxRange;
};

const BACKGROUND_SYNTAX_TILE_CHARS = 120_000;

export class EditorSyntaxController {
  private syntaxStatus: "plain" | "loading" | "ready" | "error" = "plain";
  private syntaxSession: EditorSyntaxSession | null = null;
  private highlighterSession: EditorHighlighterSession | null = null;
  private providerHighlighterTheme: EditorTheme | null = null;
  private highlighterTheme: EditorTheme | null = null;
  private cachedSyntaxRanges: readonly EditorSyntaxRange[] = [];
  private readonly syntaxRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>();
  private readonly rangeRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>();
  private readonly prefetchRangeRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>();
  private readonly warmRangeRequests = new LatestAsyncRequest<EditorSyntaxLoadResult>();
  private readonly highlightRequests = new LatestAsyncRequest<EditorHighlightResult>();
  private readonly highlighterThemeRequests = new LatestAsyncRequest<
    EditorTheme | null | undefined
  >();
  private currentTokens: readonly EditorToken[] = [];
  private pendingPrefetch: PendingSyntaxPrefetch | null = null;
  private pendingWarm: PendingSyntaxWarm | null = null;
  private warmGeneration = 0;

  constructor(private readonly options: EditorSyntaxControllerOptions) {}

  get status(): "plain" | "loading" | "ready" | "error" {
    return this.syntaxStatus;
  }

  get tokens(): readonly EditorToken[] {
    return this.currentTokens;
  }

  get providerTheme(): EditorTheme | null {
    return this.providerHighlighterTheme;
  }

  get theme(): EditorTheme | null {
    return this.highlighterTheme;
  }

  setTokens(tokens: readonly EditorToken[]): void {
    this.currentTokens = tokens;
    this.options.adoptTokens(tokens);
  }

  startDocument(document: EditorSyntaxDocumentStartOptions): void {
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();
    this.clearSyntaxRangeCache();
    this.highlighterSession = this.createHighlighterSession(
      document.documentId,
      document.languageId,
      document.textSnapshot,
      document.snapshot,
    );
    this.syntaxSession = this.createSyntaxSession(document);
    this.syntaxStatus = this.syntaxSession ? "loading" : "plain";
  }

  clearDocument(): void {
    this.syntaxStatus = "plain";
    this.clearSyntaxRangeCache();
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();
  }

  dispose(): void {
    this.highlighterThemeRequests.dispose();
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();
  }

  reloadHighlighterAndSyntax(): void {
    this.reloadHighlighterSession();
    this.reloadSyntaxSession();
  }

  reloadSyntaxSession(): void {
    this.disposeSyntaxSession();
    this.clearSyntaxRangeCache();
    this.options.clearSyntaxFolds();

    const session = this.options.getSession();
    if (!session) return;

    this.syntaxSession = this.createSyntaxSession({
      documentId: this.options.getCurrentSessionDocumentId(),
      languageId: this.options.getLanguageId(),
      textSnapshot: session.getTextSnapshot(),
      snapshot: session.getSnapshot(),
    });
    this.syntaxStatus = this.syntaxSession ? "loading" : "plain";
    this.refresh(this.options.getDocumentVersion(), null);
    this.options.notifyChange(null);
  }

  refreshHighlighterTheme(): void {
    if (!this.options.pluginHost.hasHighlighterProviders()) {
      this.setProviderHighlighterTheme(null);
      return;
    }

    this.highlighterThemeRequests.schedule({
      run: () => this.options.pluginHost.loadHighlighterTheme(),
      apply: (theme) => this.setProviderHighlighterTheme(theme),
      fail: () => this.setProviderHighlighterTheme(null),
    });
  }

  refresh(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    if (!this.options.getSession()) return;
    if (change && (change.kind === "none" || change.kind === "selection")) return;
    if (change) this.clearSyntaxRangeCache();

    this.refreshStructuralSyntax(documentVersion, change, options);
    this.refreshHighlightTokens(documentVersion, change, options);
  }

  refreshVisibleRange(documentVersion: number, options: EditorSyntaxRefreshOptions = {}): void {
    if (!this.syntaxSession?.queryRange) return;
    if (!this.options.getSession()) return;
    if (!this.canQuerySyntaxRange()) return;

    const range = options.range ?? this.options.getVisibleSyntaxRange();
    if (!range) return;
    if (this.repaintCachedVisibleSyntaxRange(range)) return;

    this.scheduleSyntaxRangeRequest(this.rangeRequests, documentVersion, range, options, "visible");
  }

  prefetchVisibleRange(
    documentVersion: number,
    range: EditorSyntaxRange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): boolean {
    if (!this.syntaxSession?.queryRange) return false;
    if (!this.options.getSession()) return false;
    if (!this.canQuerySyntaxRange()) return false;
    if (!range || syntaxRangeCoverage(range, this.cachedSyntaxRanges) === "full") return false;
    if (this.rangeRequests.isActive()) {
      this.pendingPrefetch = { documentVersion, range, options };
      return true;
    }

    this.scheduleSyntaxRangeRequest(
      this.prefetchRangeRequests,
      documentVersion,
      range,
      options,
      "prefetch",
    );
    return true;
  }

  warmSyntaxAroundRange(
    documentVersion: number,
    seedRange: EditorSyntaxRange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    if (!this.syntaxSession?.queryRange) return;
    if (!this.options.getSession()) return;
    if (!this.canQuerySyntaxRange()) return;
    if (!seedRange) return;

    const pendingWarm = {
      delayMs: options.delayMs ?? 120,
      documentVersion,
      generation: this.nextWarmGeneration(),
      seedRange,
    };
    this.pendingWarm = pendingWarm;
    this.warmRangeRequests.cancel();
    this.scheduleNextWarmRange(pendingWarm);
  }

  private reloadHighlighterSession(): void {
    this.disposeHighlighterSession();

    const session = this.options.getSession();
    if (!session) return;

    this.highlighterSession = this.createHighlighterSession(
      this.options.getCurrentSessionDocumentId(),
      this.options.getLanguageId(),
      session.getTextSnapshot(),
      session.getSnapshot(),
    );
    this.refreshHighlighterTheme();
    this.refreshHighlightTokens(this.options.getDocumentVersion(), null);
  }

  private createSyntaxSession(
    document: EditorSyntaxDocumentStartOptions,
  ): EditorSyntaxSession | null {
    if (!document.languageId) return null;

    const options = {
      documentId: document.documentId,
      languageId: document.languageId,
      includeHighlights: !this.highlighterSession,
      includeCaptures: false,
      syntaxMode: "range" as const,
      textSnapshot: document.textSnapshot,
      snapshot: document.snapshot,
    };
    const sessionOptions = defineLazyTextProperty(options);
    return (
      this.options.pluginHost.createSyntaxSession(sessionOptions) ??
      getEditorSyntaxSessionFactory()?.(sessionOptions) ??
      null
    );
  }

  private createHighlighterSession(
    documentId: string,
    languageId: EditorSyntaxLanguageId | null,
    textSnapshot: DocumentTextSnapshot,
    snapshot: PieceTableSnapshot,
  ): EditorHighlighterSession | null {
    return this.options.pluginHost.createHighlighterSession(
      defineLazyTextProperty({
        documentId,
        languageId,
        textSnapshot,
        snapshot,
      }),
    );
  }

  private disposeSyntaxSession(): void {
    this.syntaxRequests.cancel();
    this.rangeRequests.cancel();
    this.prefetchRangeRequests.cancel();
    this.warmRangeRequests.cancel();
    this.pendingPrefetch = null;
    this.pendingWarm = null;
    this.clearSyntaxRangeCache();
    this.syntaxSession?.dispose();
    this.syntaxSession = null;
  }

  private scheduleSyntaxRangeRequest(
    request: LatestAsyncRequest<EditorSyntaxLoadResult>,
    documentVersion: number,
    range: EditorSyntaxRange,
    options: EditorSyntaxRefreshOptions,
    kind: "visible" | "prefetch",
  ): void {
    request.schedule({
      delayMs: options.delayMs ?? 50,
      run: () => this.loadSyntaxRangeResult(range),
      apply: (result, startedAt) => {
        const applied = this.applySyntaxResult(result, documentVersion, startedAt);
        if (applied && kind === "visible" && !this.flushPendingPrefetch()) {
          this.flushPendingWarm();
        }
        if (applied && kind === "prefetch") this.flushPendingWarm();
      },
      fail: (error, startedAt) =>
        this.recoverSyntaxError(documentVersion, null, error, startedAt),
    });
  }

  private repaintCachedVisibleSyntaxRange(range: EditorSyntaxRange): boolean {
    const coverage = syntaxRangeCoverage(range, this.cachedSyntaxRanges);
    if (coverage === "none") return false;

    this.options.adoptTokens(this.currentTokens);
    if (coverage === "partial") return false;

    this.rangeRequests.cancel();
    logEditorSyntaxDebug("repaint cached visible syntax range", {
      range,
      cachedRanges: this.cachedSyntaxRanges.length,
    });
    return true;
  }

  private disposeHighlighterSession(): void {
    this.highlightRequests.cancel();
    this.highlighterSession?.dispose();
    this.highlighterSession = null;
    this.setHighlighterTheme(null);
  }

  private refreshStructuralSyntax(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    const session = this.options.getSession();
    if (!this.syntaxSession || !session || !this.options.getLanguageId()) return;

    this.syntaxStatus = "loading";

    const delayMs = options.delayMs ?? syntaxRefreshDelay(change);
    logEditorSyntaxDebug("schedule structural syntax", {
      ...this.debugContext(documentVersion),
      changeKind: change?.kind ?? "refresh",
      delayMs,
    });
    this.syntaxRequests.schedule({
      delayMs,
      run: () => this.loadSyntaxResult(change),
      apply: (result, startedAt) => this.applySyntaxResult(result, documentVersion, startedAt),
      fail: (error, startedAt) =>
        this.recoverSyntaxError(documentVersion, change, error, startedAt),
    });
  }

  private refreshHighlightTokens(
    documentVersion: number,
    change: DocumentSessionChange | null,
    options: EditorSyntaxRefreshOptions = {},
  ): void {
    const session = this.options.getSession();
    if (!this.highlighterSession || !session) return;

    const delayMs = options.delayMs ?? syntaxRefreshDelay(change);
    logEditorSyntaxDebug("schedule plugin highlighting", {
      ...this.debugContext(documentVersion),
      changeKind: change?.kind ?? "refresh",
      delayMs,
    });
    this.highlightRequests.schedule({
      delayMs,
      run: () => this.loadHighlightResult(change),
      apply: (result, startedAt) => this.applyHighlightResult(result, documentVersion, startedAt),
      fail: (_error, startedAt) =>
        this.recoverHighlightError(documentVersion, change, _error, startedAt),
    });
  }

  private loadSyntaxResult(change: DocumentSessionChange | null): Promise<EditorSyntaxLoadResult> {
    if (!this.syntaxSession) return Promise.reject(new Error("No syntax session"));
    return this.loadSyntaxBaseResult(change).then((result) =>
      this.syntaxSession?.queryRange && this.canQuerySyntaxRange()
        ? this.loadCurrentSyntaxRangeResult()
        : { range: null, result },
    );
  }

  private loadSyntaxBaseResult(change: DocumentSessionChange | null): Promise<EditorSyntaxResult> {
    if (!this.syntaxSession) return Promise.reject(new Error("No syntax session"));
    if (change) return this.syntaxSession.applyChange(change);

    const snapshot = this.options.getSession()?.getSnapshot();
    if (!snapshot) return Promise.reject(new Error("No document snapshot"));
    return this.syntaxSession.refresh(snapshot);
  }

  private loadCurrentSyntaxRangeResult(): Promise<EditorSyntaxLoadResult> {
    const range = this.options.getVisibleSyntaxRange();
    if (!range) {
      return Promise.resolve({
        range: null,
        result: this.syntaxSession?.getResult() ?? createEmptySyntaxResult(),
      });
    }
    return this.loadSyntaxRangeResult(range);
  }

  private loadSyntaxRangeResult(range: EditorSyntaxRange): Promise<EditorSyntaxLoadResult> {
    if (!this.syntaxSession?.queryRange) {
      return Promise.resolve({
        range: null,
        result: this.syntaxSession?.getResult() ?? createEmptySyntaxResult(),
      });
    }
    if (!this.canQuerySyntaxRange()) {
      return Promise.resolve({
        range: null,
        result: createEmptySyntaxResult(),
        skipApply: true,
      });
    }

    return this.syntaxSession.queryRange(range).then((result) => ({ range, result }));
  }

  private loadHighlightResult(
    change: DocumentSessionChange | null,
  ): Promise<EditorHighlightResult> {
    if (!this.highlighterSession) return Promise.reject(new Error("No highlighter session"));
    if (!change) {
      const snapshot = this.options.getSession()?.getSnapshot();
      if (!snapshot) return Promise.reject(new Error("No document snapshot"));
      return this.highlighterSession.refresh(snapshot);
    }

    return this.highlighterSession.applyChange(change);
  }

  private applySyntaxResult(
    loadResult: EditorSyntaxLoadResult,
    documentVersion: number,
    startedAt: number,
  ): boolean {
    const session = this.options.getSession();
    if (loadResult.skipApply) return false;
    if (!session || documentVersion !== this.options.getDocumentVersion()) return false;

    const result = loadResult.result;
    this.syntaxStatus = "ready";
    logEditorSyntaxDebug("apply structural syntax", {
      ...this.debugContext(documentVersion),
      brackets: result.brackets.length,
      captures: result.captures.length,
      errors: result.errors.length,
      folds: result.folds.length,
      injections: result.injections.length,
      tokens: result.tokens.length,
    });
    const nextTokens = this.highlighterSession
      ? this.currentTokens
      : this.syntaxTokensForResult(result.tokens, loadResult.range);
    const tokenChange = session.adoptTokens(nextTokens);
    const timedChange = appendTiming(tokenChange, "editor.syntax", startedAt);
    if (!this.highlighterSession) this.setTokens(nextTokens);
    if (!this.highlighterSession && loadResult.range) this.rememberSyntaxRange(loadResult.range);
    if (!this.highlighterSession && loadResult.range && !this.pendingWarm) {
      this.warmSyntaxAroundRange(documentVersion, loadResult.range);
    }
    this.options.setSyntaxFolds(result.folds);
    this.options.notifyChange(timedChange);
    return true;
  }

  private canQuerySyntaxRange(): boolean {
    return this.syntaxSession?.canQueryRange?.() ?? true;
  }

  private flushPendingPrefetch(): boolean {
    const pending = this.pendingPrefetch;
    this.pendingPrefetch = null;
    if (!pending) return false;
    if (pending.documentVersion !== this.options.getDocumentVersion()) return false;

    const scheduled = this.prefetchVisibleRange(
      pending.documentVersion,
      pending.range,
      pending.options,
    );
    if (!scheduled) this.flushPendingWarm();
    return scheduled;
  }

  private flushPendingWarm(): void {
    const pending = this.pendingWarm;
    if (!pending) return;
    if (pending.documentVersion !== this.options.getDocumentVersion()) return;

    this.scheduleNextWarmRange(pending);
  }

  private scheduleNextWarmRange(pending: PendingSyntaxWarm): void {
    if (pending.generation !== this.warmGeneration) return;
    if (!this.canRunWarmRangeRequest()) return;

    const range = this.nextWarmRange(pending.seedRange);
    if (!range) {
      this.pendingWarm = null;
      return;
    }

    this.warmRangeRequests.schedule({
      delayMs: pending.delayMs,
      run: () => this.loadSyntaxRangeResult(range),
      apply: (result, startedAt) => {
        if (pending.generation !== this.warmGeneration) return;
        const applied = this.applySyntaxResult(result, pending.documentVersion, startedAt);
        if (applied) this.scheduleNextWarmRange(pending);
      },
      fail: (error, startedAt) =>
        this.recoverSyntaxError(pending.documentVersion, null, error, startedAt),
    });
  }

  private canRunWarmRangeRequest(): boolean {
    if (!this.syntaxSession?.queryRange) return false;
    if (!this.options.getSession()) return false;
    if (!this.canQuerySyntaxRange()) return false;
    if (this.rangeRequests.isActive()) return false;
    return !this.prefetchRangeRequests.isActive();
  }

  private nextWarmRange(seedRange: EditorSyntaxRange): EditorSyntaxRange | null {
    const session = this.options.getSession();
    const documentLength = session?.getSnapshot().length ?? 0;
    return nextUncachedSyntaxWarmRange(documentLength, seedRange, this.cachedSyntaxRanges);
  }

  private nextWarmGeneration(): number {
    this.warmGeneration += 1;
    return this.warmGeneration;
  }

  private syntaxTokensForResult(
    tokens: readonly EditorToken[],
    range: EditorSyntaxRange | null,
  ): readonly EditorToken[] {
    if (!range) return tokens;
    return mergeSyntaxRangeTokens(this.currentTokens, tokens, range);
  }

  private rememberSyntaxRange(range: EditorSyntaxRange): void {
    this.cachedSyntaxRanges = appendCachedSyntaxRange(this.cachedSyntaxRanges, range);
  }

  private clearSyntaxRangeCache(): void {
    this.cachedSyntaxRanges = [];
  }

  private applyHighlightResult(
    result: EditorHighlightResult,
    documentVersion: number,
    startedAt: number,
  ): void {
    const session = this.options.getSession();
    if (!session || documentVersion !== this.options.getDocumentVersion()) return;

    logEditorSyntaxDebug("apply plugin highlighting", {
      ...this.debugContext(documentVersion),
      tokens: result.tokens.length,
      themeChanged: result.theme !== undefined,
    });
    if (result.theme !== undefined) this.setHighlighterTheme(result.theme);
    const tokenChange = session.adoptTokens(result.tokens);
    const timedChange = appendTiming(tokenChange, "editor.highlight", startedAt);
    this.setTokens(result.tokens);
    this.options.notifyChange(timedChange);
  }

  private applySyntaxError(documentVersion: number): void {
    if (documentVersion !== this.options.getDocumentVersion()) return;

    this.syntaxStatus = "error";
    warnEditorSyntax("mark structural syntax error", this.debugContext(documentVersion));
    this.options.notifyChange(null);
  }

  private recoverSyntaxError(
    documentVersion: number,
    change: DocumentSessionChange | null,
    error: unknown,
    startedAt: number,
  ): void {
    if (documentVersion !== this.options.getDocumentVersion()) return;
    warnEditorSyntax(`structural syntax request failed: ${syntaxErrorMessage(error)}`, {
      ...this.debugContext(documentVersion),
      changeKind: change?.kind ?? "refresh",
      error: syntaxDebugError(error),
      startedAt,
    });

    if (!change) {
      this.applySyntaxError(documentVersion);
      return;
    }

    warnEditorSyntax("reload structural syntax after edit failure", {
      ...this.debugContext(documentVersion),
      changeKind: change.kind,
    });
    this.reloadSyntaxSession();
  }

  private applyHighlightError(documentVersion: number, startedAt: number): void {
    const session = this.options.getSession();
    if (!session || documentVersion !== this.options.getDocumentVersion()) return;

    warnEditorSyntax("clear plugin highlighting after error", this.debugContext(documentVersion));
    this.setHighlighterTheme(null);
    const tokenChange = session.adoptTokens([]);
    const timedChange = appendTiming(tokenChange, "editor.highlightError", startedAt);
    this.setTokens([]);
    this.options.notifyChange(timedChange);
  }

  private recoverHighlightError(
    documentVersion: number,
    change: DocumentSessionChange | null,
    error: unknown,
    startedAt: number,
  ): void {
    if (documentVersion !== this.options.getDocumentVersion()) return;
    warnEditorSyntax(`plugin highlighting request failed: ${syntaxErrorMessage(error)}`, {
      ...this.debugContext(documentVersion),
      changeKind: change?.kind ?? "refresh",
      error: syntaxDebugError(error),
      startedAt,
    });

    if (!change) {
      this.applyHighlightError(documentVersion, startedAt);
      return;
    }

    warnEditorSyntax("reload plugin highlighter after edit failure", {
      ...this.debugContext(documentVersion),
      changeKind: change.kind,
    });
    this.reloadHighlighterSession();
  }

  private debugContext(documentVersion: number): EditorSyntaxDebugPayload {
    const session = this.options.getSession();
    return {
      currentDocumentVersion: this.options.getDocumentVersion(),
      documentId: this.options.getCurrentSessionDocumentId(),
      documentLength: session?.getSnapshot().length ?? null,
      documentVersion,
      hasHighlighterSession: Boolean(this.highlighterSession),
      hasSyntaxSession: Boolean(this.syntaxSession),
      languageId: this.options.getLanguageId(),
      syntaxStatus: this.syntaxStatus,
    };
  }

  private setHighlighterTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null;
    if (editorThemesEqual(this.highlighterTheme, nextTheme)) return;

    this.highlighterTheme = nextTheme;
    this.options.notifyThemeChanged();
  }

  private setProviderHighlighterTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null;
    if (editorThemesEqual(this.providerHighlighterTheme, nextTheme)) return;

    this.providerHighlighterTheme = nextTheme;
    this.options.notifyThemeChanged();
  }
}

type EditorSyntaxDebugPayload = Record<string, unknown>;

const logEditorSyntaxDebug = (message: string, payload: EditorSyntaxDebugPayload): void => {
  if (!isEditorSyntaxDebugEnabled()) return;

  logEditorSyntaxDebugEnabled();
  console.info(`[editor-syntax] ${message}`, payload);
};

const warnEditorSyntax = (message: string, payload: EditorSyntaxDebugPayload): void => {
  console.warn(`[editor-syntax] ${message}`, payload);
};

let editorSyntaxDebugEnabledLogged = false;

const logEditorSyntaxDebugEnabled = (): void => {
  if (editorSyntaxDebugEnabledLogged) return;

  editorSyntaxDebugEnabledLogged = true;
  console.info("[editor-syntax] debug enabled");
};

const isEditorSyntaxDebugEnabled = (): boolean => {
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

const syntaxDebugError = (error: unknown): EditorSyntaxDebugPayload => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { value: String(error) };
};

const syntaxErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const mergeSyntaxRangeTokens = (
  currentTokens: readonly EditorToken[],
  rangeTokens: readonly EditorToken[],
  range: EditorSyntaxRange,
): readonly EditorToken[] => {
  const merged: EditorToken[] = [];
  appendTokensOutsideRange(merged, currentTokens, range);
  appendTokens(merged, rangeTokens);
  merged.sort(compareEditorTokens);

  const indexBuilder = createEditorTokenIndexBuilder();
  for (const token of merged) appendEditorTokenIndexEntry(indexBuilder, token);
  finishEditorTokenIndex(merged, indexBuilder);
  return merged;
};

const appendTokensOutsideRange = (
  target: EditorToken[],
  tokens: readonly EditorToken[],
  range: EditorSyntaxRange,
): void => {
  for (const token of tokens) {
    if (token.end <= range.startIndex || token.start >= range.endIndex) target.push(token);
  }
};

const appendTokens = (target: EditorToken[], tokens: readonly EditorToken[]): void => {
  for (const token of tokens) target.push(token);
};

const compareEditorTokens = (left: EditorToken, right: EditorToken): number =>
  left.start - right.start || left.end - right.end;

const appendCachedSyntaxRange = (
  ranges: readonly EditorSyntaxRange[],
  range: EditorSyntaxRange,
): readonly EditorSyntaxRange[] => {
  if (range.endIndex <= range.startIndex) return ranges;

  const merged: EditorSyntaxRange[] = [];
  const sorted = [...ranges, range].sort(compareSyntaxRanges);
  for (const current of sorted) mergeCachedSyntaxRange(merged, current);
  return merged;
};

const mergeCachedSyntaxRange = (
  ranges: EditorSyntaxRange[],
  range: EditorSyntaxRange,
): void => {
  const previous = ranges.at(-1);
  if (!previous || range.startIndex > previous.endIndex) {
    ranges.push(range);
    return;
  }

  ranges[ranges.length - 1] = {
    startIndex: previous.startIndex,
    endIndex: Math.max(previous.endIndex, range.endIndex),
  };
};

type SyntaxRangeCoverage = "none" | "partial" | "full";

const syntaxRangeCoverage = (
  range: EditorSyntaxRange,
  cachedRanges: readonly EditorSyntaxRange[],
): SyntaxRangeCoverage => {
  let cursor = range.startIndex;
  let overlaps = false;
  for (const cachedRange of cachedRanges) {
    if (cachedRange.endIndex <= range.startIndex) continue;
    if (cachedRange.startIndex >= range.endIndex) break;

    overlaps = true;
    if (cachedRange.endIndex <= cursor) continue;
    if (cachedRange.startIndex > cursor) return "partial";

    cursor = Math.max(cursor, cachedRange.endIndex);
    if (cursor >= range.endIndex) return "full";
  }

  return overlaps ? "partial" : "none";
};

const compareSyntaxRanges = (left: EditorSyntaxRange, right: EditorSyntaxRange): number =>
  left.startIndex - right.startIndex || left.endIndex - right.endIndex;

const nextUncachedSyntaxWarmRange = (
  documentLength: number,
  seedRange: EditorSyntaxRange,
  cachedRanges: readonly EditorSyntaxRange[],
): EditorSyntaxRange | null => {
  if (documentLength <= 0) return null;

  const tileCount = Math.ceil(documentLength / BACKGROUND_SYNTAX_TILE_CHARS);
  const seedCenter = boundedIndex(
    Math.floor((seedRange.startIndex + seedRange.endIndex) / 2),
    documentLength,
  );
  const seedTile = Math.min(tileCount - 1, Math.floor(seedCenter / BACKGROUND_SYNTAX_TILE_CHARS));
  for (let distance = 0; distance < tileCount; distance += 1) {
    const forward = syntaxWarmTileRange(seedTile + distance, documentLength);
    if (isUncachedSyntaxWarmRange(forward, cachedRanges)) return forward;
    if (distance === 0) continue;

    const backward = syntaxWarmTileRange(seedTile - distance, documentLength);
    if (isUncachedSyntaxWarmRange(backward, cachedRanges)) return backward;
  }

  return null;
};

const syntaxWarmTileRange = (
  tileIndex: number,
  documentLength: number,
): EditorSyntaxRange | null => {
  if (tileIndex < 0) return null;

  const startIndex = tileIndex * BACKGROUND_SYNTAX_TILE_CHARS;
  if (startIndex >= documentLength) return null;

  return {
    startIndex,
    endIndex: Math.min(documentLength, startIndex + BACKGROUND_SYNTAX_TILE_CHARS),
  };
};

const isUncachedSyntaxWarmRange = (
  range: EditorSyntaxRange | null,
  cachedRanges: readonly EditorSyntaxRange[],
): range is EditorSyntaxRange => {
  if (!range) return false;
  return syntaxRangeCoverage(range, cachedRanges) !== "full";
};

const boundedIndex = (index: number, documentLength: number): number =>
  Math.max(0, Math.min(index, Math.max(0, documentLength - 1)));
