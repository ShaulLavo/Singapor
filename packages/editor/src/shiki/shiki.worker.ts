import { createHighlighter, type HighlighterGeneric } from "shiki";
import { createIncrementalTokenizer, type IncrementalTokenizer } from "./tokenizer";
import { snapshotToEditorTokens } from "./editor-tokens";
import type { EditorTheme } from "../theme";
import type {
  ShikiWorkerDocumentOptions,
  ShikiWorkerEditRequest,
  ShikiWorkerOpenRequest,
  ShikiWorkerRequest,
  ShikiWorkerResponse,
  ShikiWorkerResult,
  ShikiWorkerThemeRequest,
} from "./workerTypes";

type DocumentState = {
  readonly documentId: string;
  readonly lang: string;
  readonly theme: string;
  readonly highlighter: HighlighterGeneric<string, string>;
  readonly tokenizer: IncrementalTokenizer;
};

type ShikiThemeLike = {
  readonly bg?: string;
  readonly fg?: string;
  readonly colors?: Readonly<Record<string, string | undefined>>;
  readonly tokenColors?: readonly ShikiThemeSettingLike[];
  readonly settings?: readonly ShikiThemeSettingLike[];
};

type ShikiThemeSettingLike = {
  readonly scope?: string | readonly string[];
  readonly settings?: {
    readonly foreground?: string;
  };
};

type SyntaxScopeMapping = {
  readonly key: keyof NonNullable<EditorTheme["syntax"]>;
  readonly scopes: readonly string[];
};

const SYNTAX_SCOPE_MAPPINGS: readonly SyntaxScopeMapping[] = [
  {
    key: "attribute",
    scopes: ["entity.other.attribute-name", "meta.attribute", "support.type.property-name"],
  },
  {
    key: "bracket",
    scopes: ["punctuation.section", "punctuation.definition", "meta.brace"],
  },
  {
    key: "comment",
    scopes: ["comment"],
  },
  {
    key: "constant",
    scopes: ["constant.language", "constant.character", "variable.other.constant"],
  },
  {
    key: "function",
    scopes: ["entity.name.function", "support.function", "meta.function-call"],
  },
  {
    key: "keyword",
    scopes: ["keyword", "storage.modifier", "storage.type", "storage"],
  },
  {
    key: "keywordDeclaration",
    scopes: ["keyword.declaration", "storage.type", "storage", "keyword.operator.new"],
  },
  {
    key: "keywordImport",
    scopes: [
      "keyword.control.import",
      "keyword.control.from",
      "keyword.operator.expression.import",
    ],
  },
  {
    key: "namespace",
    scopes: ["entity.name.namespace", "entity.name.module", "support.module"],
  },
  {
    key: "number",
    scopes: ["constant.numeric"],
  },
  {
    key: "property",
    scopes: [
      "meta.property-name",
      "variable.other.property",
      "meta.object-literal.key",
      "support.type.property-name",
    ],
  },
  {
    key: "string",
    scopes: ["string", "string.quoted"],
  },
  {
    key: "type",
    scopes: ["support.type", "support.class", "entity.name.type", "entity.name.class"],
  },
  {
    key: "typeDefinition",
    scopes: ["entity.name.type.class", "entity.name.class", "entity.name.type"],
  },
  {
    key: "typeParameter",
    scopes: ["entity.name.type.type-parameter", "meta.type.parameters"],
  },
  {
    key: "variable",
    scopes: ["variable.other", "variable.parameter", "identifier"],
  },
  {
    key: "variableBuiltin",
    scopes: ["variable.language", "support.variable", "support.constant"],
  },
];

const documents = new Map<string, DocumentState>();
const documentTasks = new Map<string, Promise<ShikiWorkerResult | undefined>>();
const highlighterPromises = new Map<string, Promise<HighlighterGeneric<string, string>>>();

self.onmessage = (event: MessageEvent<ShikiWorkerRequest>): void => {
  void handleRequest(event.data);
};

const handleRequest = async (request: ShikiWorkerRequest): Promise<void> => {
  try {
    const result = await runRequest(request.payload);
    postResponse({ id: request.id, ok: true, result });
  } catch (error) {
    postResponse({ id: request.id, ok: false, error: createErrorMessage(error) });
  }
};

const runRequest = (
  payload: ShikiWorkerRequest["payload"],
): Promise<ShikiWorkerResult | undefined> => {
  if (payload.type === "open") {
    return runDocumentTask(payload.documentId, () => openDocument(payload));
  }
  if (payload.type === "edit") {
    return runDocumentTask(payload.documentId, () => editDocument(payload));
  }
  if (payload.type === "disposeDocument") {
    disposeDocument(payload.documentId);
    return Promise.resolve(undefined);
  }
  if (payload.type === "theme") {
    return loadTheme(payload);
  }

  disposeAll();
  return Promise.resolve(undefined);
};

const runDocumentTask = (
  documentId: string,
  task: () => Promise<ShikiWorkerResult>,
): Promise<ShikiWorkerResult> => {
  const previous = documentTasks.get(documentId) ?? Promise.resolve(undefined);
  const next = previous.catch(() => undefined).then(task);
  documentTasks.set(documentId, next);
  void next.finally(() => clearDocumentTask(documentId, next)).catch(() => undefined);
  return next;
};

const clearDocumentTask = (
  documentId: string,
  task: Promise<ShikiWorkerResult | undefined>,
): void => {
  if (documentTasks.get(documentId) !== task) return;
  documentTasks.delete(documentId);
};

const openDocument = async (payload: ShikiWorkerOpenRequest): Promise<ShikiWorkerResult> => {
  const highlighter = await ensureHighlighter(payload);
  const { tokenizer } = await createIncrementalTokenizer({
    lang: payload.lang,
    theme: payload.theme,
    code: payload.text,
    highlighter,
  });

  const state = {
    documentId: payload.documentId,
    lang: payload.lang,
    theme: payload.theme,
    highlighter,
    tokenizer,
  };
  documents.set(payload.documentId, state);
  return resultFromState(state);
};

const editDocument = async (payload: ShikiWorkerEditRequest): Promise<ShikiWorkerResult> => {
  const existing = documents.get(payload.documentId);
  if (!existing && payload.text !== undefined)
    return openDocument(openRequestFromEdit(payload, payload.text));
  if (!existing) throw new Error("Unable to edit unopened Shiki document without text");
  if (!documentMatches(existing, payload) && payload.text !== undefined) {
    return openDocument(openRequestFromEdit(payload, payload.text));
  }
  if (!documentMatches(existing, payload)) {
    throw new Error("Unable to reopen Shiki document without text");
  }

  if (payload.edit) {
    existing.tokenizer.applyEdit(payload.edit);
  } else {
    existing.tokenizer.update(payload.text ?? existing.tokenizer.getCode());
  }

  return resultFromState(existing);
};

const openRequestFromEdit = (payload: ShikiWorkerEditRequest, text: string) => ({
  documentId: payload.documentId,
  lang: payload.lang,
  theme: payload.theme,
  text,
  langs: payload.langs,
  themes: payload.themes,
  type: "open" as const,
});

const ensureHighlighter = (
  options: ShikiWorkerDocumentOptions,
): Promise<HighlighterGeneric<string, string>> => {
  const langs = unique([options.lang, ...options.langs]);
  const themes = unique([options.theme, ...options.themes]);
  return ensureHighlighterFor(langs, themes);
};

const ensureHighlighterFor = (
  langs: readonly string[],
  themes: readonly string[],
): Promise<HighlighterGeneric<string, string>> => {
  const key = highlighterKey(langs, themes);
  const existing = highlighterPromises.get(key);
  if (existing) return existing;

  const promise = createHighlighter({ langs: [...langs], themes: [...themes] }) as Promise<
    HighlighterGeneric<string, string>
  >;
  highlighterPromises.set(key, promise);
  return promise;
};

const loadTheme = async (payload: ShikiWorkerThemeRequest): Promise<ShikiWorkerResult> => {
  const themes = unique([payload.theme, ...payload.themes]);
  const highlighter = await ensureHighlighterFor([], themes);
  return { theme: editorThemeFromHighlighter(highlighter, payload.theme) };
};

const resultFromState = (state: DocumentState): ShikiWorkerResult => ({
  documentId: state.documentId,
  tokens: snapshotToEditorTokens(state.tokenizer.getSnapshot()),
  theme: editorThemeFromHighlighter(state.highlighter, state.theme),
});

const documentMatches = (state: DocumentState, payload: ShikiWorkerDocumentOptions): boolean =>
  state.lang === payload.lang && state.theme === payload.theme;

const disposeDocument = (documentId: string): void => {
  documents.delete(documentId);
  documentTasks.delete(documentId);
};

const disposeAll = (): void => {
  documents.clear();
  documentTasks.clear();
  for (const promise of highlighterPromises.values()) {
    void promise.then((highlighter) => highlighter.dispose()).catch(() => undefined);
  }
  highlighterPromises.clear();
};

const postResponse = (response: ShikiWorkerResponse): void => {
  self.postMessage(response);
};

const highlighterKey = (langs: readonly string[], themes: readonly string[]): string => {
  const normalizedLangs = langs.toSorted();
  const normalizedThemes = themes.toSorted();
  return JSON.stringify({ langs: normalizedLangs, themes: normalizedThemes });
};

const unique = (items: readonly string[]): string[] => Array.from(new Set(items));

const createErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

function editorThemeFromHighlighter(
  highlighter: HighlighterGeneric<string, string>,
  themeName: string,
): EditorTheme | undefined {
  const getTheme = (highlighter as Partial<Pick<HighlighterGeneric<string, string>, "getTheme">>)
    .getTheme;
  if (!getTheme) return undefined;

  return editorThemeFromShikiTheme(getTheme.call(highlighter, themeName));
}

function editorThemeFromShikiTheme(theme: ShikiThemeLike): EditorTheme {
  const backgroundColor = theme.bg ?? theme.colors?.["editor.background"];
  const foregroundColor = theme.fg ?? theme.colors?.["editor.foreground"];
  const syntax = editorSyntaxThemeFromShikiTheme(theme);

  return {
    backgroundColor,
    foregroundColor,
    gutterBackgroundColor: theme.colors?.["editorGutter.background"] ?? backgroundColor,
    gutterForegroundColor: theme.colors?.["editorLineNumber.foreground"],
    caretColor: theme.colors?.["editorCursor.foreground"] ?? foregroundColor,
    minimapBackgroundColor: backgroundColor,
    ...(syntax ? { syntax } : {}),
  };
}

function editorSyntaxThemeFromShikiTheme(
  theme: ShikiThemeLike,
): NonNullable<EditorTheme["syntax"]> | undefined {
  const syntax: NonNullable<EditorTheme["syntax"]> = {};
  for (const mapping of SYNTAX_SCOPE_MAPPINGS) {
    const color = themeColorForScopes(theme, mapping.scopes);
    if (color !== undefined) syntax[mapping.key] = color;
  }
  const bracketColor = theme.fg ?? theme.colors?.["editor.foreground"];
  if (syntax.bracket === undefined && bracketColor !== undefined) syntax.bracket = bracketColor;
  if (Object.keys(syntax).length === 0) return undefined;
  return syntax;
}

function themeColorForScopes(
  theme: ShikiThemeLike,
  targetScopes: readonly string[],
): string | undefined {
  const settings = shikiThemeSettings(theme);
  let bestMatch: ScopeColorMatch | null = null;
  for (let index = 0; index < settings.length; index += 1) {
    const match = settingColorMatch(settings[index], targetScopes, index);
    if (!match) continue;
    if (!isBetterScopeColorMatch(match, bestMatch)) continue;

    bestMatch = match;
  }
  return bestMatch?.color;
}

type ScopeColorMatch = {
  readonly color: string;
  readonly order: number;
  readonly score: number;
};

function shikiThemeSettings(theme: ShikiThemeLike): readonly ShikiThemeSettingLike[] {
  return theme.tokenColors ?? theme.settings ?? [];
}

function settingColorMatch(
  setting: ShikiThemeSettingLike | undefined,
  targetScopes: readonly string[],
  order: number,
): ScopeColorMatch | null {
  const color = setting?.settings?.foreground;
  if (!color) return null;

  const score = settingScopeMatchScore(setting, targetScopes);
  if (score === 0) return null;

  return { color, order, score };
}

function settingScopeMatchScore(
  setting: ShikiThemeSettingLike,
  targetScopes: readonly string[],
): number {
  let bestScore = 0;
  const scopes = normalizedSettingScopes(setting.scope);
  for (const scope of scopes) {
    bestScore = Math.max(bestScore, scopeMatchScore(scope, targetScopes));
  }
  return bestScore;
}

function normalizedSettingScopes(scope: string | readonly string[] | undefined): readonly string[] {
  if (scope === undefined) return [];
  if (typeof scope === "string") return splitScopeList(scope);
  return scope.flatMap(splitScopeList);
}

function splitScopeList(scope: string): string[] {
  return scope
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function scopeMatchScore(scope: string, targetScopes: readonly string[]): number {
  let bestScore = 0;
  for (let index = 0; index < targetScopes.length; index += 1) {
    bestScore = Math.max(bestScore, scopeTargetMatchScore(scope, targetScopes[index], index));
  }
  return bestScore;
}

function scopeTargetMatchScore(scope: string, target: string, targetIndex: number): number {
  const targetPriority = Math.max(0, 20 - targetIndex);
  if (scope === target) return 300 + targetPriority + scopeDepth(scope);
  if (target.startsWith(`${scope}.`)) return 100 + targetPriority + scopeDepth(scope);
  return 0;
}

function scopeDepth(scope: string): number {
  return scope.split(".").length;
}

function isBetterScopeColorMatch(
  candidate: ScopeColorMatch,
  current: ScopeColorMatch | null,
): boolean {
  if (!current) return true;
  if (candidate.score !== current.score) return candidate.score > current.score;
  return candidate.order > current.order;
}
