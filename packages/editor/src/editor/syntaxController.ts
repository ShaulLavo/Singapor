import type { DocumentSession, DocumentSessionChange } from "../documentSession";
import { defineLazyTextProperty, type DocumentTextSnapshot } from "../documentTextSnapshot";
import type { PieceTableSnapshot } from "../pieceTable/pieceTableTypes";
import type { EditorHighlightResult, EditorHighlighterSession, EditorPluginHost } from "../plugins";
import type { EditorSyntaxResult, EditorSyntaxSession } from "../syntax/session";
import type { EditorSyntaxLanguageId, FoldRange } from "../syntax/session";
import type { EditorTheme } from "../theme";
import { editorThemesEqual } from "../theme";
import type { EditorToken } from "../tokens";
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
  adoptTokens(tokens: readonly EditorToken[]): void;
  clearSyntaxFolds(): void;
  setSyntaxFolds(folds: readonly FoldRange[]): void;
  notifyChange(change: DocumentSessionChange | null): void;
  notifyThemeChanged(): void;
};

export type EditorSyntaxRefreshOptions = {
  readonly delayMs?: number;
};

export class EditorSyntaxController {
  private syntaxStatus: "plain" | "loading" | "ready" | "error" = "plain";
  private syntaxSession: EditorSyntaxSession | null = null;
  private highlighterSession: EditorHighlighterSession | null = null;
  private providerHighlighterTheme: EditorTheme | null = null;
  private highlighterTheme: EditorTheme | null = null;
  private readonly syntaxRequests = new LatestAsyncRequest<EditorSyntaxResult>();
  private readonly highlightRequests = new LatestAsyncRequest<EditorHighlightResult>();
  private readonly highlighterThemeRequests = new LatestAsyncRequest<
    EditorTheme | null | undefined
  >();
  private currentTokens: readonly EditorToken[] = [];

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

    this.refreshStructuralSyntax(documentVersion, change, options);
    this.refreshHighlightTokens(documentVersion, change, options);
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
    this.syntaxSession?.dispose();
    this.syntaxSession = null;
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

  private loadSyntaxResult(change: DocumentSessionChange | null): Promise<EditorSyntaxResult> {
    if (!this.syntaxSession) return Promise.reject(new Error("No syntax session"));
    if (!change) {
      const snapshot = this.options.getSession()?.getSnapshot();
      if (!snapshot) return Promise.reject(new Error("No document snapshot"));
      return this.syntaxSession.refresh(snapshot);
    }

    return this.syntaxSession.applyChange(change);
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
    result: EditorSyntaxResult,
    documentVersion: number,
    startedAt: number,
  ): void {
    const session = this.options.getSession();
    if (!session || documentVersion !== this.options.getDocumentVersion()) return;

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
    const nextTokens = this.highlighterSession ? this.currentTokens : result.tokens;
    const tokenChange = session.adoptTokens(nextTokens);
    const timedChange = appendTiming(tokenChange, "editor.syntax", startedAt);
    if (!this.highlighterSession) this.setTokens(result.tokens);
    this.options.setSyntaxFolds(result.folds);
    this.options.notifyChange(timedChange);
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
