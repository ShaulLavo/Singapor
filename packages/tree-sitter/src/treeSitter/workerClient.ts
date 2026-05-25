import type { TreeSitterLanguageDescriptor } from './registry'
import type {
  TreeSitterEditRequest,
  TreeSitterLanguageId,
  TreeSitterParseAckResult,
  TreeSitterParseRequest,
  TreeSitterParseResult,
  TreeSitterRangeRequest,
  TreeSitterRangeResult,
  TreeSitterSelectionRequest,
  TreeSitterSelectionResult,
  TreeSitterSyntaxRange,
  TreeSitterWorkerRequest,
  TreeSitterWorkerRequestPayload,
  TreeSitterWorkerResponse,
  TreeSitterWorkerResult,
} from './types'
import type { PieceTableSnapshot } from '@editor/core/document'
import { createTreeSitterSourceDescriptor, type TreeSitterSourceDescriptor } from './source'

type PendingRequest = {
  readonly documentId: string | null
  readonly cancellationFlag: Int32Array | null
  readonly payload: TreeSitterWorkerRequestPayload
  readonly sourceEpoch: number | null
  readonly resolve: (result: TreeSitterWorkerResult) => void
  readonly reject: (error: Error) => void
}

type TreeSitterParseDocumentRequest = Omit<
  TreeSitterParseRequest,
  'generation' | 'cancellationBuffer'
>
type TreeSitterEditDocumentRequest = Omit<
  TreeSitterEditRequest,
  'generation' | 'cancellationBuffer'
>
type TreeSitterRangeDocumentRequest = Omit<
  TreeSitterRangeRequest,
  'generation' | 'cancellationBuffer'
>

export type TreeSitterParsePayload = {
  readonly documentId: string
  readonly snapshotVersion: number
  readonly languageId: TreeSitterLanguageId
  readonly includeHighlights?: boolean
  readonly includeCaptures?: boolean
  readonly resultMode?: 'full'
  readonly snapshot: PieceTableSnapshot
}
export type TreeSitterParseOnlyPayload = Omit<TreeSitterParsePayload, 'resultMode'> & {
  readonly resultMode: 'parseOnly'
}
export type TreeSitterBackendParsePayload = TreeSitterParsePayload | TreeSitterParseOnlyPayload

export type TreeSitterEditPayload = {
  readonly documentId: string
  readonly previousSnapshotVersion: number
  readonly snapshotVersion: number
  readonly languageId: TreeSitterLanguageId
  readonly includeHighlights: boolean
  readonly includeCaptures?: boolean
  readonly resultMode?: 'full'
  readonly snapshot: PieceTableSnapshot
  readonly edits: readonly TreeSitterEditRequest['edits'][number][]
  readonly inputEdits: readonly TreeSitterEditRequest['inputEdits'][number][]
}
export type TreeSitterEditOnlyPayload = Omit<TreeSitterEditPayload, 'resultMode'> & {
  readonly resultMode: 'parseOnly'
}
export type TreeSitterBackendEditPayload = TreeSitterEditPayload | TreeSitterEditOnlyPayload
export type TreeSitterRangePayload = {
  readonly documentId: string
  readonly snapshotVersion: number
  readonly languageId: TreeSitterLanguageId
  readonly includeHighlights?: boolean
  readonly includeCaptures?: boolean
  readonly range: TreeSitterSyntaxRange
}
export type TreeSitterSelectionPayload = Omit<TreeSitterSelectionRequest, 'type'>

export type TreeSitterBackend = {
  registerLanguages(languages: readonly TreeSitterLanguageDescriptor[]): Promise<void>
  parse(
    payload: TreeSitterBackendParsePayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
  edit(
    payload: TreeSitterBackendEditPayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
  queryRange?(payload: TreeSitterRangePayload): Promise<TreeSitterRangeResult | undefined>
  select(payload: TreeSitterSelectionPayload): Promise<TreeSitterSelectionResult | undefined>
  disposeDocument(documentId: string): void
  dispose?(): Promise<void>
}

const supportsWorkers = (): boolean => typeof Worker !== 'undefined'
const supportsSharedCancellation = (): boolean => typeof SharedArrayBuffer !== 'undefined'

export const canUseTreeSitterWorker = (): boolean => supportsWorkers()

export class TreeSitterWorkerClient implements TreeSitterBackend {
  private worker: Worker | null = null
  private nextRequestId = 1
  private nextGeneration = 1
  private initPromise: Promise<void> | null = null
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly sentSourceChunkIds = new Map<string, Set<string>>()
  private readonly sourceDocumentEpochs = new Map<string, number>()
  private readonly registeredLanguageSignatures = new Map<TreeSitterLanguageId, string>()

  public async registerLanguages(
    languages: readonly TreeSitterLanguageDescriptor[],
  ): Promise<void> {
    const nextLanguages = this.unregisteredLanguages(languages)
    if (nextLanguages.length === 0) return

    const handle = await this.ensureWorkerReady()
    if (!handle) return

    await this.postRequest({ type: 'registerLanguages', languages: nextLanguages })
    for (const language of nextLanguages) {
      this.registeredLanguageSignatures.set(language.id, languageDescriptorSignature(language))
    }
  }

  public async parse(
    payload: TreeSitterBackendParsePayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined> {
    const handle = await this.ensureWorkerReady()
    if (!handle) return undefined
    const source = this.createSourceDescriptor(payload.documentId, payload.snapshot)
    const request: TreeSitterParseDocumentRequest = {
      type: 'parse',
      documentId: payload.documentId,
      snapshotVersion: payload.snapshotVersion,
      languageId: payload.languageId,
      includeHighlights: payload.includeHighlights ?? true,
      includeCaptures: payload.includeCaptures,
      resultMode: payload.resultMode,
      source,
    }
    const result = await this.postDocumentRequest(request)
    if (isTreeSitterParseResult(result)) return result
    if (isTreeSitterParseAckResult(result)) return result
    return undefined
  }

  public async edit(
    payload: TreeSitterBackendEditPayload,
  ): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined> {
    const handle = await this.ensureWorkerReady()
    if (!handle) return undefined
    const source = this.createSourceDescriptor(payload.documentId, payload.snapshot)
    const result = await this.postDocumentRequest({
      type: 'edit',
      documentId: payload.documentId,
      previousSnapshotVersion: payload.previousSnapshotVersion,
      snapshotVersion: payload.snapshotVersion,
      languageId: payload.languageId,
      includeHighlights: payload.includeHighlights,
      includeCaptures: payload.includeCaptures,
      resultMode: payload.resultMode,
      source,
      edits: payload.edits,
      inputEdits: payload.inputEdits,
    })
    if (isTreeSitterParseResult(result)) return result
    if (isTreeSitterParseAckResult(result)) return result
    return undefined
  }

  public async queryRange(
    payload: TreeSitterRangePayload,
  ): Promise<TreeSitterRangeResult | undefined> {
    const handle = await this.ensureWorkerReady()
    if (!handle) return undefined
    const result = await this.postRangeRequest({
      type: 'queryRange',
      documentId: payload.documentId,
      snapshotVersion: payload.snapshotVersion,
      languageId: payload.languageId,
      includeHighlights: payload.includeHighlights ?? true,
      includeCaptures: payload.includeCaptures,
      range: payload.range,
    })
    return isTreeSitterRangeResult(result) ? result : undefined
  }

  public async select(
    payload: TreeSitterSelectionPayload,
  ): Promise<TreeSitterSelectionResult | undefined> {
    const handle = await this.ensureWorkerReady()
    if (!handle) return undefined
    const result = await this.postRequest({ type: 'selection', ...payload })
    return isTreeSitterSelectionResult(result) ? result : undefined
  }

  public disposeDocument(documentId: string): void {
    this.invalidateDocumentSourceState(documentId)
    void this.postRequest({ type: 'disposeDocument', documentId }).catch(() => undefined)
  }

  public async dispose(): Promise<void> {
    if (!this.worker) return

    try {
      await this.postRequest({ type: 'dispose' })
    } finally {
      this.worker.terminate()
      this.worker = null
      this.initPromise = null
      this.registeredLanguageSignatures.clear()
      this.sentSourceChunkIds.clear()
      this.sourceDocumentEpochs.clear()
      this.rejectPendingRequests(new Error('Tree-sitter worker disposed'))
    }
  }

  private getWorker(): Worker | null {
    if (!supportsWorkers()) return null
    if (this.worker) return this.worker

    const handle = new Worker(new URL('./treeSitter.worker.ts', import.meta.url), {
      type: 'module',
    })
    handle.onmessage = (event) => this.handleWorkerMessage(event)
    handle.onerror = (event) => this.handleWorkerError(handle, event)
    this.worker = handle
    return handle
  }

  private async ensureWorkerReady(): Promise<Worker | null> {
    const handle = this.getWorker()
    if (!handle) return null

    if (!this.initPromise) {
      this.initPromise = this.postRequest({ type: 'init' }).then(() => undefined)
    }

    await this.initPromise
    return handle
  }

  private postRequest(
    payload: TreeSitterWorkerRequestPayload,
  ): Promise<TreeSitterWorkerResult> {
    const handle = this.getWorker()
    if (!handle) return Promise.resolve(undefined)

    const id = this.nextRequestId
    this.nextRequestId += 1
    const request: TreeSitterWorkerRequest = { id, payload }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        documentId: documentIdForPayload(payload),
        cancellationFlag: cancellationFlagForPayload(payload),
        payload,
        sourceEpoch: this.sourceEpochForPayload(payload),
        resolve,
        reject,
      })
      handle.postMessage(request)
    })
  }

  private postDocumentRequest(
    payload: TreeSitterParseDocumentRequest | TreeSitterEditDocumentRequest,
  ): Promise<TreeSitterWorkerResult> {
    return this.postRequest(
      this.withCancellation(this.cancelPreviousDocumentRequests(payload.documentId), payload),
    )
  }

  private postRangeRequest(payload: TreeSitterRangeDocumentRequest): Promise<TreeSitterWorkerResult> {
    return this.postRequest(
      this.withCancellation(this.cancelPreviousRangeRequests(payload.documentId), payload),
    )
  }

  private cancelPreviousDocumentRequests(documentId: string): Int32Array | null {
    const cancellationFlag = this.createCancellationFlag()
    for (const pending of this.pendingRequests.values()) {
      if (pending.documentId !== documentId) continue
      if (pending.cancellationFlag) Atomics.store(pending.cancellationFlag, 0, 1)
    }

    return cancellationFlag
  }

  private cancelPreviousRangeRequests(documentId: string): Int32Array | null {
    const cancellationFlag = this.createCancellationFlag()
    for (const pending of this.pendingRequests.values()) {
      if (pending.documentId !== documentId) continue
      if (pending.payload.type !== 'queryRange') continue
      if (pending.cancellationFlag) Atomics.store(pending.cancellationFlag, 0, 1)
    }

    return cancellationFlag
  }

  private createCancellationFlag(): Int32Array | null {
    if (!supportsSharedCancellation()) return null
    return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  }

  private withCancellation<
    TPayload extends
      | TreeSitterParseDocumentRequest
      | TreeSitterEditDocumentRequest
      | TreeSitterRangeDocumentRequest,
  >(
    cancellationFlag: Int32Array | null,
    payload: TPayload,
  ): TPayload & { readonly generation: number; readonly cancellationBuffer?: SharedArrayBuffer } {
    const generation = this.nextGeneration
    this.nextGeneration += 1
    if (!cancellationFlag) return { ...payload, generation }
    return {
      ...payload,
      generation,
      cancellationBuffer: cancellationFlag.buffer as SharedArrayBuffer,
    }
  }

  private handleWorkerMessage(event: MessageEvent<TreeSitterWorkerResponse>): void {
    const response = event.data
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return

    this.pendingRequests.delete(response.id)
    if (response.ok) {
      this.markSourceChunksAsSent(pending)
      pending.resolve(response.result)
      return
    }

    if (pending.documentId && shouldInvalidateDocumentSourceState(response.error)) {
      this.invalidateDocumentSourceState(pending.documentId)
    }
    pending.reject(new Error(response.error))
  }

  private handleWorkerError(failedWorker: Worker, event: ErrorEvent): void {
    if (failedWorker !== this.worker) return

    const error = new Error(event.message || 'Tree-sitter worker failed')
    failedWorker.terminate()
    this.worker = null
    this.rejectPendingRequests(error)
    this.initPromise = null
    this.registeredLanguageSignatures.clear()
    this.sentSourceChunkIds.clear()
    this.sourceDocumentEpochs.clear()
  }

  private rejectPendingRequests(error: Error): void {
    for (const request of this.pendingRequests.values()) request.reject(error)
    this.pendingRequests.clear()
  }

  private shouldRegisterLanguageWithWorker(language: TreeSitterLanguageDescriptor): boolean {
    return (
      this.registeredLanguageSignatures.get(language.id) !==
      languageDescriptorSignature(language)
    )
  }

  private unregisteredLanguages(
    languages: readonly TreeSitterLanguageDescriptor[],
  ): readonly TreeSitterLanguageDescriptor[] {
    const nextLanguages: TreeSitterLanguageDescriptor[] = []
    const nextSignatures = new Map<TreeSitterLanguageId, string>()

    for (const language of languages) {
      if (!this.shouldRegisterLanguageWithWorker(language)) continue

      const signature = languageDescriptorSignature(language)
      if (nextSignatures.get(language.id) === signature) continue

      nextSignatures.set(language.id, signature)
      nextLanguages.push(language)
    }

    return nextLanguages
  }

  private createSourceDescriptor(
    documentId: string,
    snapshot: PieceTableSnapshot,
  ): TreeSitterSourceDescriptor {
    return createTreeSitterSourceDescriptor(snapshot, {
      sentChunkIds: this.sourceChunkIdsForDocument(documentId),
    })
  }

  private sourceChunkIdsForDocument(documentId: string): Set<string> {
    const existing = this.sentSourceChunkIds.get(documentId)
    if (existing) return existing

    const sent = new Set<string>()
    this.sentSourceChunkIds.set(documentId, sent)
    return sent
  }

  private markSourceChunksAsSent(pending: PendingRequest): void {
    const { payload } = pending
    if (!('source' in payload)) return
    if (!this.canMarkSourceChunksAsSent(pending)) return

    const sent = this.sourceChunkIdsForDocument(payload.documentId)
    for (const chunk of payload.source.chunks) sent.add(chunk.chunkId)
  }

  private canMarkSourceChunksAsSent(pending: PendingRequest): boolean {
    if (!('source' in pending.payload)) return false
    return pending.sourceEpoch === this.currentSourceEpoch(pending.payload.documentId)
  }

  private sourceEpochForPayload(payload: TreeSitterWorkerRequestPayload): number | null {
    if (!('source' in payload)) return null
    return this.currentSourceEpoch(payload.documentId)
  }

  private currentSourceEpoch(documentId: string): number {
    return this.sourceDocumentEpochs.get(documentId) ?? 0
  }

  private invalidateDocumentSourceState(documentId: string): void {
    this.sentSourceChunkIds.delete(documentId)
    this.sourceDocumentEpochs.set(documentId, this.currentSourceEpoch(documentId) + 1)
  }
}

export const createTreeSitterWorkerBackend = (): TreeSitterBackend =>
  new TreeSitterWorkerClient()

let compatibilityWorkerClient: TreeSitterWorkerClient | null = null

const defaultTreeSitterWorkerClient = (): TreeSitterWorkerClient => {
  if (!compatibilityWorkerClient) compatibilityWorkerClient = new TreeSitterWorkerClient()
  return compatibilityWorkerClient
}

export const registerTreeSitterLanguagesWithWorker = (
  languages: readonly TreeSitterLanguageDescriptor[],
): Promise<void> => defaultTreeSitterWorkerClient().registerLanguages(languages)

export function parseWithTreeSitter(
  payload: TreeSitterParseOnlyPayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
export function parseWithTreeSitter(
  payload: TreeSitterParsePayload,
): Promise<TreeSitterParseResult | undefined>
export function parseWithTreeSitter(
  payload: TreeSitterBackendParsePayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
export function parseWithTreeSitter(
  payload: TreeSitterBackendParsePayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined> {
  return defaultTreeSitterWorkerClient().parse(payload)
}

export function editWithTreeSitter(
  payload: TreeSitterEditOnlyPayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
export function editWithTreeSitter(
  payload: TreeSitterEditPayload,
): Promise<TreeSitterParseResult | undefined>
export function editWithTreeSitter(
  payload: TreeSitterBackendEditPayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
export function editWithTreeSitter(
  payload: TreeSitterBackendEditPayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined> {
  return defaultTreeSitterWorkerClient().edit(payload)
}

export const queryRangeWithTreeSitter = (
  payload: TreeSitterRangePayload,
): Promise<TreeSitterRangeResult | undefined> =>
  defaultTreeSitterWorkerClient().queryRange(payload)

export const selectWithTreeSitter = (
  payload: TreeSitterSelectionPayload,
): Promise<TreeSitterSelectionResult | undefined> =>
  defaultTreeSitterWorkerClient().select(payload)

export const disposeTreeSitterDocument = (documentId: string): void => {
  defaultTreeSitterWorkerClient().disposeDocument(documentId)
}

export const disposeTreeSitterWorker = async (): Promise<void> => {
  await compatibilityWorkerClient?.dispose()
  compatibilityWorkerClient = null
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
  })
}

function sortedItems(items: readonly string[]): readonly string[] {
  return items.toSorted()
}

const documentIdForPayload = (payload: TreeSitterWorkerRequestPayload): string | null => {
  if ('documentId' in payload) return payload.documentId
  return null
}

const cancellationFlagForPayload = (payload: TreeSitterWorkerRequestPayload): Int32Array | null => {
  if (!('cancellationBuffer' in payload)) return null
  if (!payload.cancellationBuffer) return null
  return new Int32Array(payload.cancellationBuffer)
}

const shouldInvalidateDocumentSourceState = (error: string): boolean => {
  if (error.includes('Tree-sitter source chunk')) return true
  if (error.includes('Tree-sitter resolve source failed')) return true
  return error.includes('Tree-sitter cache miss')
}

const isTreeSitterParseResult = (result: TreeSitterWorkerResult): result is TreeSitterParseResult =>
  Boolean(result && 'captures' in result && 'folds' in result)

const isTreeSitterParseAckResult = (
  result: TreeSitterWorkerResult,
): result is TreeSitterParseAckResult =>
  Boolean(result && 'status' in result && result.status === 'parsed')

const isTreeSitterRangeResult = (result: TreeSitterWorkerResult): result is TreeSitterRangeResult =>
  Boolean(result && 'range' in result && 'tokens' in result)

const isTreeSitterSelectionResult = (
  result: TreeSitterWorkerResult,
): result is TreeSitterSelectionResult =>
  Boolean(result && 'status' in result && 'ranges' in result)
