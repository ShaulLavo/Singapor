import { afterEach, describe, expect, it, vi } from "vitest";
import { createPieceTableSnapshot } from "@editor/core";
import type { TreeSitterLanguageDescriptor } from "../src";
import type {
  TreeSitterParseRequest,
  TreeSitterParseResult,
  TreeSitterWorkerRequest,
  TreeSitterWorkerRequestPayload,
  TreeSitterWorkerResult,
} from "../src/treeSitter/types";
import type { TreeSitterParsePayload } from "../src/treeSitter/workerClient.ts";

type WorkerClientModule = typeof import("../src/treeSitter/workerClient.ts");

type FakeWorkerRequest = TreeSitterWorkerRequest;

const fakeWorkers: FakeWorker[] = [];
let currentClient: WorkerClientModule | null = null;

class FakeWorker {
  static autoResolve = true;

  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly messages: FakeWorkerRequest[] = [];
  private terminated = false;

  public constructor() {
    fakeWorkers.push(this);
  }

  public postMessage(message: FakeWorkerRequest): void {
    this.messages.push(message);
    if (FakeWorker.autoResolve) queueMicrotask(() => this.resolveRequest(message));
  }

  public terminate(): void {
    this.terminated = true;
  }

  public get isTerminated(): boolean {
    return this.terminated;
  }

  public resolveRequest(message: FakeWorkerRequest, result?: TreeSitterWorkerResult): void {
    if (this.terminated) return;

    this.onmessage?.({
      data: { id: message.id, ok: true, result },
    } as MessageEvent);
  }

  public rejectRequest(message: FakeWorkerRequest, error: string): void {
    if (this.terminated) return;

    this.onmessage?.({
      data: { id: message.id, ok: false, error },
    } as MessageEvent);
  }
}

describe("tree-sitter worker client language registration cache", () => {
  afterEach(async () => {
    FakeWorker.autoResolve = true;
    await currentClient?.disposeTreeSitterWorker();
    currentClient = null;
    fakeWorkers.length = 0;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not post duplicate language descriptors", async () => {
    const client = await loadWorkerClient();
    const descriptor = languageDescriptor("typescript");

    await client.registerTreeSitterLanguagesWithWorker([descriptor]);
    await client.registerTreeSitterLanguagesWithWorker([descriptor]);

    expect(registerLanguageRequests()).toHaveLength(1);
  });

  it("posts changed descriptors for the same language id", async () => {
    const client = await loadWorkerClient();

    await client.registerTreeSitterLanguagesWithWorker([languageDescriptor("typescript")]);
    await client.registerTreeSitterLanguagesWithWorker([
      languageDescriptor("typescript", "(identifier) @variable.builtin"),
    ]);

    expect(registerLanguageRequests()).toHaveLength(2);
  });

  it("clears registered descriptor cache when the worker is disposed", async () => {
    const client = await loadWorkerClient();
    const descriptor = languageDescriptor("typescript");

    await client.registerTreeSitterLanguagesWithWorker([descriptor]);
    await client.disposeTreeSitterWorker();
    await client.registerTreeSitterLanguagesWithWorker([descriptor]);

    expect(registerLanguageRequests()).toHaveLength(2);
  });

  it("creates a fresh worker after a worker error rejects an in-flight request", async () => {
    const client = await loadWorkerClient();
    const descriptor = languageDescriptor("typescript");
    const registration = client.registerTreeSitterLanguagesWithWorker([descriptor]);
    const firstWorker = fakeWorkerAt(0);

    firstWorker.onerror?.({ message: "boom" } as ErrorEvent);

    await expect(registration).rejects.toThrow("boom");
    await client.registerTreeSitterLanguagesWithWorker([descriptor]);
    const nextWorker = fakeWorkerAt(1);

    expect(firstWorker.isTerminated).toBe(true);
    expect(fakeWorkers).toHaveLength(2);
    expect(nextWorker.messages.some((message) => message.payload.type === "init")).toBe(true);
    expect(
      nextWorker.messages.some((message) => message.payload.type === "registerLanguages"),
    ).toBe(true);
  });

  it("does not mark document source chunks as sent when a request fails", async () => {
    FakeWorker.autoResolve = false;
    const client = await loadWorkerClient();
    const snapshot = createPieceTableSnapshot("const answer = 1;");
    const firstParse = client.parseWithTreeSitter(parsePayload(snapshot, 1));
    const worker = fakeWorkerAt(0);

    worker.resolveRequest(requestOfType(worker, "init"));
    await flushMicrotasks();
    const failedRequest = parseRequests(worker)[0]!;
    expect(failedRequest.payload.source.chunks.length).toBeGreaterThan(0);

    worker.rejectRequest(failedRequest, "parse failed");
    await expect(firstParse).rejects.toThrow("parse failed");

    const retryParse = client.parseWithTreeSitter(parsePayload(snapshot, 2));
    await flushMicrotasks();
    const retryRequest = parseRequests(worker)[1]!;

    expect(retryRequest.payload.source.chunks.length).toBeGreaterThan(0);
    worker.resolveRequest(retryRequest, parseResult(2));
    await expect(retryParse).resolves.toMatchObject({ snapshotVersion: 2 });
  });
});

async function loadWorkerClient(): Promise<WorkerClientModule> {
  vi.resetModules();
  fakeWorkers.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
  currentClient = await import("../src/treeSitter/workerClient.ts");
  return currentClient;
}

function registerLanguageRequests(): FakeWorkerRequest[] {
  return fakeWorkers.flatMap((worker) =>
    worker.messages.filter((message) => message.payload.type === "registerLanguages"),
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function fakeWorkerAt(index: number): FakeWorker {
  const fakeWorker = fakeWorkers[index];
  if (!fakeWorker) throw new Error(`Expected fake worker at index ${index}`);
  return fakeWorker;
}

function requestOfType<TType extends TreeSitterWorkerRequestPayload["type"]>(
  worker: FakeWorker,
  type: TType,
): Extract<FakeWorkerRequest, { readonly payload: { readonly type: TType } }> {
  const request = worker.messages.find((message) => message.payload.type === type);
  if (!request) throw new Error(`Expected ${type} request`);
  return request as Extract<FakeWorkerRequest, { readonly payload: { readonly type: TType } }>;
}

function parseRequests(worker: FakeWorker): TreeSitterParseWorkerRequest[] {
  return worker.messages.filter((message): message is TreeSitterParseWorkerRequest =>
    isParseRequest(message.payload),
  );
}

type TreeSitterParseWorkerRequest = FakeWorkerRequest & {
  readonly payload: TreeSitterParseRequest;
};

function isParseRequest(
  payload: TreeSitterWorkerRequestPayload,
): payload is TreeSitterParseRequest {
  return payload.type === "parse";
}

function languageDescriptor(
  id: string,
  highlightQuerySource = "(identifier) @variable",
): TreeSitterLanguageDescriptor {
  return {
    aliases: [id],
    extensions: [`.${id}`],
    highlightQuerySource,
    id,
    wasmUrl: `/${id}.wasm`,
  };
}

function parsePayload(
  snapshot: ReturnType<typeof createPieceTableSnapshot>,
  snapshotVersion: number,
): TreeSitterParsePayload {
  return {
    documentId: "doc.ts",
    includeHighlights: true,
    languageId: "typescript",
    snapshot,
    snapshotVersion,
  };
}

function parseResult(snapshotVersion: number): TreeSitterParseResult {
  return {
    brackets: [],
    captures: [],
    documentId: "doc.ts",
    errors: [],
    folds: [],
    injections: [],
    languageId: "typescript",
    snapshotVersion,
    timings: [],
  };
}
