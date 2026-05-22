import type { TreeSitterLanguageDescriptor } from "./registry";
import type {
  TreeSitterEditRequest,
  TreeSitterLanguageId,
  TreeSitterParseRequest,
  TreeSitterParseResult,
  TreeSitterSelectionRequest,
  TreeSitterSelectionResult,
  TreeSitterWorkerRequest,
  TreeSitterWorkerRequestPayload,
  TreeSitterWorkerResponse,
  TreeSitterWorkerResult,
} from "./types";
import type { PieceTableSnapshot } from "@editor/core";
import { createTreeSitterSourceDescriptor, type TreeSitterSourceDescriptor } from "./source";

type PendingRequest = {
  readonly documentId: string | null;
  readonly cancellationFlag: Int32Array | null;
  readonly payload: TreeSitterWorkerRequestPayload;
  readonly resolve: (result: TreeSitterWorkerResult) => void;
  readonly reject: (error: Error) => void;
};

type TreeSitterParseDocumentRequest = Omit<
  TreeSitterParseRequest,
  "generation" | "cancellationBuffer"
>;
type TreeSitterEditDocumentRequest = Omit<
  TreeSitterEditRequest,
  "generation" | "cancellationBuffer"
>;

export type TreeSitterParsePayload = {
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly includeHighlights?: boolean;
  readonly includeCaptures?: boolean;
  readonly snapshot: PieceTableSnapshot;
};

export type TreeSitterEditPayload = {
  readonly documentId: string;
  readonly previousSnapshotVersion: number;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly includeHighlights: boolean;
  readonly includeCaptures?: boolean;
  readonly snapshot: PieceTableSnapshot;
  readonly edits: readonly TreeSitterEditRequest["edits"][number][];
  readonly inputEdits: readonly TreeSitterEditRequest["inputEdits"][number][];
};
export type TreeSitterSelectionPayload = Omit<TreeSitterSelectionRequest, "type">;

export type TreeSitterBackend = {
  registerLanguages(languages: readonly TreeSitterLanguageDescriptor[]): Promise<void>;
  parse(payload: TreeSitterParsePayload): Promise<TreeSitterParseResult | undefined>;
  edit(payload: TreeSitterEditPayload): Promise<TreeSitterParseResult | undefined>;
  select(payload: TreeSitterSelectionPayload): Promise<TreeSitterSelectionResult | undefined>;
  disposeDocument(documentId: string): void;
  dispose?(): Promise<void>;
};

const supportsWorkers = (): boolean => typeof Worker !== "undefined";
const supportsSharedCancellation = (): boolean => typeof SharedArrayBuffer !== "undefined";

let worker: Worker | null = null;
let nextRequestId = 1;
let nextGeneration = 1;
let initPromise: Promise<void> | null = null;
const pendingRequests = new Map<number, PendingRequest>();
const sentSourceChunkIds = new Map<string, Set<string>>();
const registeredLanguageSignatures = new Map<TreeSitterLanguageId, string>();

const getWorker = (): Worker | null => {
  if (!supportsWorkers()) return null;
  if (worker) return worker;

  const handle = new Worker(new URL("./treeSitter.worker.ts", import.meta.url), { type: "module" });
  handle.onmessage = handleWorkerMessage;
  handle.onerror = (event) => handleWorkerError(handle, event);
  worker = handle;
  return handle;
};

const ensureWorkerReady = async (): Promise<Worker | null> => {
  const handle = getWorker();
  if (!handle) return null;

  if (!initPromise) {
    initPromise = postRequest({ type: "init" }).then(() => undefined);
  }

  await initPromise;
  return handle;
};

export const canUseTreeSitterWorker = (): boolean => supportsWorkers();

export const registerTreeSitterLanguagesWithWorker = async (
  languages: readonly TreeSitterLanguageDescriptor[],
): Promise<void> => {
  const nextLanguages = unregisteredLanguages(languages);
  if (nextLanguages.length === 0) return;

  const handle = await ensureWorkerReady();
  if (!handle) return;

  await postRequest({ type: "registerLanguages", languages: nextLanguages });
  for (const language of nextLanguages) {
    registeredLanguageSignatures.set(language.id, languageDescriptorSignature(language));
  }
};

export const parseWithTreeSitter = async (
  payload: TreeSitterParsePayload,
): Promise<TreeSitterParseResult | undefined> => {
  const handle = await ensureWorkerReady();
  if (!handle) return undefined;
  const source = createSourceDescriptor(payload.documentId, payload.snapshot);
  const request: TreeSitterParseDocumentRequest = {
    type: "parse",
    documentId: payload.documentId,
    snapshotVersion: payload.snapshotVersion,
    languageId: payload.languageId,
    includeHighlights: payload.includeHighlights ?? true,
    includeCaptures: payload.includeCaptures,
    source,
  };
  const result = await postDocumentRequest(request);
  return isTreeSitterParseResult(result) ? result : undefined;
};

export const editWithTreeSitter = async (
  payload: TreeSitterEditPayload,
): Promise<TreeSitterParseResult | undefined> => {
  const handle = await ensureWorkerReady();
  if (!handle) return undefined;
  const source = createSourceDescriptor(payload.documentId, payload.snapshot);
  const result = await postDocumentRequest({
    type: "edit",
    documentId: payload.documentId,
    previousSnapshotVersion: payload.previousSnapshotVersion,
    snapshotVersion: payload.snapshotVersion,
    languageId: payload.languageId,
    includeHighlights: payload.includeHighlights,
    includeCaptures: payload.includeCaptures,
    source,
    edits: payload.edits,
    inputEdits: payload.inputEdits,
  });
  return isTreeSitterParseResult(result) ? result : undefined;
};

export const selectWithTreeSitter = async (
  payload: TreeSitterSelectionPayload,
): Promise<TreeSitterSelectionResult | undefined> => {
  const handle = await ensureWorkerReady();
  if (!handle) return undefined;
  const result = await postRequest({ type: "selection", ...payload });
  return isTreeSitterSelectionResult(result) ? result : undefined;
};

export const disposeTreeSitterDocument = (documentId: string): void => {
  logTreeSitterWorkerDebug("dispose document", { documentId });
  sentSourceChunkIds.delete(documentId);
  void postRequest({ type: "disposeDocument", documentId }).catch(() => undefined);
};

export const disposeTreeSitterWorker = async (): Promise<void> => {
  if (!worker) return;

  try {
    logTreeSitterWorkerDebug("dispose worker", {
      pendingRequests: pendingRequests.size,
      sentSourceDocuments: sentSourceChunkIds.size,
    });
    await postRequest({ type: "dispose" });
  } finally {
    worker.terminate();
    worker = null;
    initPromise = null;
    registeredLanguageSignatures.clear();
    sentSourceChunkIds.clear();
    rejectPendingRequests(new Error("Tree-sitter worker disposed"));
  }
};

export const createTreeSitterWorkerBackend = (): TreeSitterBackend => ({
  registerLanguages: registerTreeSitterLanguagesWithWorker,
  parse: parseWithTreeSitter,
  edit: editWithTreeSitter,
  select: selectWithTreeSitter,
  disposeDocument: disposeTreeSitterDocument,
  dispose: disposeTreeSitterWorker,
});

const postRequest = (payload: TreeSitterWorkerRequestPayload): Promise<TreeSitterWorkerResult> => {
  const handle = getWorker();
  if (!handle) return Promise.resolve(undefined);

  const id = nextRequestId++;
  const request: TreeSitterWorkerRequest = { id, payload };
  logTreeSitterWorkerDebug("post request", requestDebugInfo(request));

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      documentId: documentIdForPayload(payload),
      cancellationFlag: cancellationFlagForPayload(payload),
      payload,
      resolve,
      reject,
    });
    handle.postMessage(request);
  });
};

function postDocumentRequest(
  payload: TreeSitterParseDocumentRequest | TreeSitterEditDocumentRequest,
): Promise<TreeSitterWorkerResult> {
  return postRequest(withCancellation(cancelPreviousDocumentRequests(payload.documentId), payload));
}

const cancelPreviousDocumentRequests = (documentId: string): Int32Array | null => {
  let cancellationFlag: Int32Array | null = null;
  let cancelledRequests = 0;

  for (const pending of pendingRequests.values()) {
    if (pending.documentId !== documentId) continue;
    cancelledRequests += 1;
    if (pending.cancellationFlag) Atomics.store(pending.cancellationFlag, 0, 1);
  }

  if (cancelledRequests > 0) {
    logTreeSitterWorkerDebug("cancel previous document requests", {
      cancelledRequests,
      documentId,
    });
  }

  if (supportsSharedCancellation()) {
    cancellationFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  }

  return cancellationFlag;
};

const withCancellation = <
  TPayload extends TreeSitterParseDocumentRequest | TreeSitterEditDocumentRequest,
>(
  cancellationFlag: Int32Array | null,
  payload: TPayload,
): TPayload & { readonly generation: number; readonly cancellationBuffer?: SharedArrayBuffer } => {
  const generation = nextGeneration++;
  if (!cancellationFlag) return { ...payload, generation };
  return {
    ...payload,
    generation,
    cancellationBuffer: cancellationFlag.buffer as SharedArrayBuffer,
  };
};

const handleWorkerMessage = (event: MessageEvent<TreeSitterWorkerResponse>): void => {
  const response = event.data;
  const pending = pendingRequests.get(response.id);
  if (!pending) return;

  pendingRequests.delete(response.id);
  if (response.ok) {
    logTreeSitterWorkerDebug("request resolved", {
      ...workerPayloadDebugInfo(pending.payload),
      id: response.id,
      result: workerResultDebugInfo(response.result),
    });
    markSourceChunksAsSent(pending.payload);
    pending.resolve(response.result);
    return;
  }

  warnTreeSitterWorker(`request rejected: ${response.error}`, {
    ...workerPayloadDebugInfo(pending.payload),
    error: response.error,
    id: response.id,
  });
  pending.reject(new Error(response.error));
};

const handleWorkerError = (failedWorker: Worker, event: ErrorEvent): void => {
  if (failedWorker !== worker) return;

  const error = new Error(event.message || "Tree-sitter worker failed");
  warnTreeSitterWorker(`worker error: ${error.message}`, {
    error: treeSitterWorkerDebugError(error),
    pendingRequests: pendingRequests.size,
  });
  failedWorker.terminate();
  worker = null;
  rejectPendingRequests(error);
  initPromise = null;
  registeredLanguageSignatures.clear();
  sentSourceChunkIds.clear();
};

const rejectPendingRequests = (error: Error): void => {
  if (pendingRequests.size > 0) {
    warnTreeSitterWorker(`reject pending requests: ${error.message}`, {
      error: treeSitterWorkerDebugError(error),
      pendingRequests: pendingRequests.size,
    });
  }

  for (const request of pendingRequests.values()) request.reject(error);
  pendingRequests.clear();
};

function shouldRegisterLanguageWithWorker(language: TreeSitterLanguageDescriptor): boolean {
  return registeredLanguageSignatures.get(language.id) !== languageDescriptorSignature(language);
}

function unregisteredLanguages(
  languages: readonly TreeSitterLanguageDescriptor[],
): readonly TreeSitterLanguageDescriptor[] {
  const nextLanguages: TreeSitterLanguageDescriptor[] = [];
  const nextSignatures = new Map<TreeSitterLanguageId, string>();

  for (const language of languages) {
    if (!shouldRegisterLanguageWithWorker(language)) continue;

    const signature = languageDescriptorSignature(language);
    if (nextSignatures.get(language.id) === signature) continue;

    nextSignatures.set(language.id, signature);
    nextLanguages.push(language);
  }

  return nextLanguages;
}

function languageDescriptorSignature(language: TreeSitterLanguageDescriptor): string {
  return JSON.stringify({
    aliases: sortedItems(language.aliases),
    extensions: sortedItems(language.extensions),
    foldQuerySource: language.foldQuerySource,
    highlightQuerySource: language.highlightQuerySource,
    id: language.id,
    injectionQuerySource: language.injectionQuerySource,
    wasmUrl: language.wasmUrl,
  });
}

function sortedItems(items: readonly string[]): readonly string[] {
  return [...items].sort();
}

const documentIdForPayload = (payload: TreeSitterWorkerRequestPayload): string | null => {
  if ("documentId" in payload) return payload.documentId;
  return null;
};

const cancellationFlagForPayload = (payload: TreeSitterWorkerRequestPayload): Int32Array | null => {
  if (!("cancellationBuffer" in payload)) return null;
  if (!payload.cancellationBuffer) return null;
  return new Int32Array(payload.cancellationBuffer);
};

const createSourceDescriptor = (
  documentId: string,
  snapshot: PieceTableSnapshot,
): TreeSitterSourceDescriptor =>
  createTreeSitterSourceDescriptor(snapshot, {
    sentChunkIds: sourceChunkIdsForDocument(documentId),
  });

const sourceChunkIdsForDocument = (documentId: string): Set<string> => {
  const existing = sentSourceChunkIds.get(documentId);
  if (existing) return existing;

  const sent = new Set<string>();
  sentSourceChunkIds.set(documentId, sent);
  return sent;
};

const markSourceChunksAsSent = (payload: TreeSitterWorkerRequestPayload): void => {
  if (!("source" in payload)) return;

  const sent = sourceChunkIdsForDocument(payload.documentId);
  for (const chunk of payload.source.chunks) sent.add(chunk.chunkId);
  logTreeSitterWorkerDebug("mark source chunks sent", {
    documentId: payload.documentId,
    sentChunks: sent.size,
    sourceChunks: payload.source.chunks.length,
    type: payload.type,
  });
};

const isTreeSitterParseResult = (result: TreeSitterWorkerResult): result is TreeSitterParseResult =>
  Boolean(result && "captures" in result && "folds" in result);

const isTreeSitterSelectionResult = (
  result: TreeSitterWorkerResult,
): result is TreeSitterSelectionResult =>
  Boolean(result && "status" in result && "ranges" in result);

type TreeSitterWorkerDebugPayload = Record<string, unknown>;

const logTreeSitterWorkerDebug = (message: string, payload: TreeSitterWorkerDebugPayload): void => {
  if (!isTreeSitterWorkerDebugEnabled()) return;

  logTreeSitterWorkerDebugEnabled();
  console.info(`[editor-syntax:tree-sitter-worker] ${message}`, payload);
};

const warnTreeSitterWorker = (message: string, payload: TreeSitterWorkerDebugPayload): void => {
  console.warn(`[editor-syntax:tree-sitter-worker] ${message}`, payload);
};

let treeSitterWorkerDebugEnabledLogged = false;

const logTreeSitterWorkerDebugEnabled = (): void => {
  if (treeSitterWorkerDebugEnabledLogged) return;

  treeSitterWorkerDebugEnabledLogged = true;
  console.info("[editor-syntax:tree-sitter-worker] debug enabled");
};

const isTreeSitterWorkerDebugEnabled = (): boolean => {
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

const requestDebugInfo = (request: TreeSitterWorkerRequest): TreeSitterWorkerDebugPayload => ({
  id: request.id,
  ...workerPayloadDebugInfo(request.payload),
});

const workerPayloadDebugInfo = (
  payload: TreeSitterWorkerRequestPayload,
): TreeSitterWorkerDebugPayload => {
  const base = {
    documentId: documentIdForPayload(payload),
    type: payload.type,
  };
  if (!("source" in payload)) return base;

  return {
    ...base,
    generation: payload.generation,
    length: payload.source.length,
    pieces: payload.source.pieces.length,
    sourceChunks: payload.source.chunks.length,
  };
};

const workerResultDebugInfo = (
  result: TreeSitterWorkerResult,
): TreeSitterWorkerDebugPayload | null => {
  if (!result) return null;
  if (isTreeSitterSelectionResult(result)) {
    return {
      languageId: result.languageId,
      ranges: result.ranges.length,
      snapshotVersion: result.snapshotVersion,
      status: result.status,
    };
  }

  return {
    brackets: result.brackets.length,
    captures: result.captures.length,
    errors: result.errors.length,
    folds: result.folds.length,
    injections: result.injections.length,
    languageId: result.languageId,
    snapshotVersion: result.snapshotVersion,
    timings: result.timings,
  };
};

const treeSitterWorkerDebugError = (error: unknown): TreeSitterWorkerDebugPayload => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { value: String(error) };
};
