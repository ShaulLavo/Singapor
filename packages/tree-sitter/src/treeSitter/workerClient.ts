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
import type { PieceTableSnapshot } from '@editor/core'
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

let worker: Worker | null = null
let nextRequestId = 1
let nextGeneration = 1
let initPromise: Promise<void> | null = null
const pendingRequests = new Map<number, PendingRequest>()
const sentSourceChunkIds = new Map<string, Set<string>>()
const sourceDocumentEpochs = new Map<string, number>()
const registeredLanguageSignatures = new Map<TreeSitterLanguageId, string>()

const getWorker = (): Worker | null => {
  if (!supportsWorkers()) return null
  if (worker) return worker

  const handle = new Worker(new URL('./treeSitter.worker.ts', import.meta.url), { type: 'module' })
  handle.onmessage = handleWorkerMessage
  handle.onerror = (event) => handleWorkerError(handle, event)
  worker = handle
  return handle
}

const ensureWorkerReady = async (): Promise<Worker | null> => {
  const handle = getWorker()
  if (!handle) return null

  if (!initPromise) {
    initPromise = postRequest({ type: 'init' }).then(() => undefined)
  }

  await initPromise
  return handle
}

export const canUseTreeSitterWorker = (): boolean => supportsWorkers()

export const registerTreeSitterLanguagesWithWorker = async (
  languages: readonly TreeSitterLanguageDescriptor[],
): Promise<void> => {
  const nextLanguages = unregisteredLanguages(languages)
  if (nextLanguages.length === 0) return

  const handle = await ensureWorkerReady()
  if (!handle) return

  await postRequest({ type: 'registerLanguages', languages: nextLanguages })
  for (const language of nextLanguages) {
    registeredLanguageSignatures.set(language.id, languageDescriptorSignature(language))
  }
}

export function parseWithTreeSitter(
  payload: TreeSitterParseOnlyPayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
export function parseWithTreeSitter(
  payload: TreeSitterParsePayload,
): Promise<TreeSitterParseResult | undefined>
export function parseWithTreeSitter(
  payload: TreeSitterBackendParsePayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined>
export async function parseWithTreeSitter(
  payload: TreeSitterBackendParsePayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined> {
  const handle = await ensureWorkerReady()
  if (!handle) return undefined
  const source = createSourceDescriptor(payload.documentId, payload.snapshot)
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
  const result = await postDocumentRequest(request)
  if (isTreeSitterParseResult(result)) return result
  if (isTreeSitterParseAckResult(result)) return result
  return undefined
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
export async function editWithTreeSitter(
  payload: TreeSitterBackendEditPayload,
): Promise<TreeSitterParseResult | TreeSitterParseAckResult | undefined> {
  const handle = await ensureWorkerReady()
  if (!handle) return undefined
  const source = createSourceDescriptor(payload.documentId, payload.snapshot)
  const result = await postDocumentRequest({
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

export const queryRangeWithTreeSitter = async (
  payload: TreeSitterRangePayload,
): Promise<TreeSitterRangeResult | undefined> => {
  const handle = await ensureWorkerReady()
  if (!handle) return undefined
  const result = await postRangeRequest({
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

export const selectWithTreeSitter = async (
  payload: TreeSitterSelectionPayload,
): Promise<TreeSitterSelectionResult | undefined> => {
  const handle = await ensureWorkerReady()
  if (!handle) return undefined
  const result = await postRequest({ type: 'selection', ...payload })
  return isTreeSitterSelectionResult(result) ? result : undefined
}

export const disposeTreeSitterDocument = (documentId: string): void => {
  invalidateDocumentSourceState(documentId)
  void postRequest({ type: 'disposeDocument', documentId }).catch(() => undefined)
}

export const disposeTreeSitterWorker = async (): Promise<void> => {
  if (!worker) return

  try {
    await postRequest({ type: 'dispose' })
  } finally {
    worker.terminate()
    worker = null
    initPromise = null
    registeredLanguageSignatures.clear()
    sentSourceChunkIds.clear()
    sourceDocumentEpochs.clear()
    rejectPendingRequests(new Error('Tree-sitter worker disposed'))
  }
}

export const createTreeSitterWorkerBackend = (): TreeSitterBackend => ({
  registerLanguages: registerTreeSitterLanguagesWithWorker,
  parse: parseWithTreeSitter,
  edit: editWithTreeSitter,
  queryRange: queryRangeWithTreeSitter,
  select: selectWithTreeSitter,
  disposeDocument: disposeTreeSitterDocument,
  dispose: disposeTreeSitterWorker,
})

const postRequest = (payload: TreeSitterWorkerRequestPayload): Promise<TreeSitterWorkerResult> => {
  const handle = getWorker()
  if (!handle) return Promise.resolve(undefined)

  const id = nextRequestId++
  const request: TreeSitterWorkerRequest = { id, payload }

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      documentId: documentIdForPayload(payload),
      cancellationFlag: cancellationFlagForPayload(payload),
      payload,
      sourceEpoch: sourceEpochForPayload(payload),
      resolve,
      reject,
    })
    handle.postMessage(request)
  })
}

function postDocumentRequest(
  payload: TreeSitterParseDocumentRequest | TreeSitterEditDocumentRequest,
): Promise<TreeSitterWorkerResult> {
  return postRequest(withCancellation(cancelPreviousDocumentRequests(payload.documentId), payload))
}

function postRangeRequest(
  payload: TreeSitterRangeDocumentRequest,
): Promise<TreeSitterWorkerResult> {
  return postRequest(withCancellation(cancelPreviousRangeRequests(payload.documentId), payload))
}

const cancelPreviousDocumentRequests = (documentId: string): Int32Array | null => {
  let cancellationFlag: Int32Array | null = null

  for (const pending of pendingRequests.values()) {
    if (pending.documentId !== documentId) continue
    if (pending.cancellationFlag) Atomics.store(pending.cancellationFlag, 0, 1)
  }

  if (supportsSharedCancellation()) {
    cancellationFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  }

  return cancellationFlag
}

const cancelPreviousRangeRequests = (documentId: string): Int32Array | null => {
  let cancellationFlag: Int32Array | null = null

  for (const pending of pendingRequests.values()) {
    if (pending.documentId !== documentId) continue
    if (pending.payload.type !== 'queryRange') continue
    if (pending.cancellationFlag) Atomics.store(pending.cancellationFlag, 0, 1)
  }

  if (supportsSharedCancellation()) {
    cancellationFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  }

  return cancellationFlag
}

const withCancellation = <
  TPayload extends
    | TreeSitterParseDocumentRequest
    | TreeSitterEditDocumentRequest
    | TreeSitterRangeDocumentRequest,
>(
  cancellationFlag: Int32Array | null,
  payload: TPayload,
): TPayload & { readonly generation: number; readonly cancellationBuffer?: SharedArrayBuffer } => {
  const generation = nextGeneration++
  if (!cancellationFlag) return { ...payload, generation }
  return {
    ...payload,
    generation,
    cancellationBuffer: cancellationFlag.buffer as SharedArrayBuffer,
  }
}

const handleWorkerMessage = (event: MessageEvent<TreeSitterWorkerResponse>): void => {
  const response = event.data
  const pending = pendingRequests.get(response.id)
  if (!pending) return

  pendingRequests.delete(response.id)
  if (response.ok) {
    markSourceChunksAsSent(pending)
    pending.resolve(response.result)
    return
  }

  if (pending.documentId && shouldInvalidateDocumentSourceState(response.error)) {
    invalidateDocumentSourceState(pending.documentId)
  }
  pending.reject(new Error(response.error))
}

const handleWorkerError = (failedWorker: Worker, event: ErrorEvent): void => {
  if (failedWorker !== worker) return

  const error = new Error(event.message || 'Tree-sitter worker failed')
  failedWorker.terminate()
  worker = null
  rejectPendingRequests(error)
  initPromise = null
  registeredLanguageSignatures.clear()
  sentSourceChunkIds.clear()
  sourceDocumentEpochs.clear()
}

const rejectPendingRequests = (error: Error): void => {
  for (const request of pendingRequests.values()) request.reject(error)
  pendingRequests.clear()
}

function shouldRegisterLanguageWithWorker(language: TreeSitterLanguageDescriptor): boolean {
  return registeredLanguageSignatures.get(language.id) !== languageDescriptorSignature(language)
}

function unregisteredLanguages(
  languages: readonly TreeSitterLanguageDescriptor[],
): readonly TreeSitterLanguageDescriptor[] {
  const nextLanguages: TreeSitterLanguageDescriptor[] = []
  const nextSignatures = new Map<TreeSitterLanguageId, string>()

  for (const language of languages) {
    if (!shouldRegisterLanguageWithWorker(language)) continue

    const signature = languageDescriptorSignature(language)
    if (nextSignatures.get(language.id) === signature) continue

    nextSignatures.set(language.id, signature)
    nextLanguages.push(language)
  }

  return nextLanguages
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

const createSourceDescriptor = (
  documentId: string,
  snapshot: PieceTableSnapshot,
): TreeSitterSourceDescriptor =>
  createTreeSitterSourceDescriptor(snapshot, {
    sentChunkIds: sourceChunkIdsForDocument(documentId),
  })

const sourceChunkIdsForDocument = (documentId: string): Set<string> => {
  const existing = sentSourceChunkIds.get(documentId)
  if (existing) return existing

  const sent = new Set<string>()
  sentSourceChunkIds.set(documentId, sent)
  return sent
}

const markSourceChunksAsSent = (pending: PendingRequest): void => {
  const { payload } = pending
  if (!('source' in payload)) return
  if (!canMarkSourceChunksAsSent(pending)) return

  const sent = sourceChunkIdsForDocument(payload.documentId)
  for (const chunk of payload.source.chunks) sent.add(chunk.chunkId)
}

const canMarkSourceChunksAsSent = (pending: PendingRequest): boolean => {
  if (!('source' in pending.payload)) return false
  return pending.sourceEpoch === currentSourceEpoch(pending.payload.documentId)
}

const sourceEpochForPayload = (payload: TreeSitterWorkerRequestPayload): number | null => {
  if (!('source' in payload)) return null
  return currentSourceEpoch(payload.documentId)
}

const currentSourceEpoch = (documentId: string): number => sourceDocumentEpochs.get(documentId) ?? 0

const invalidateDocumentSourceState = (documentId: string): void => {
  sentSourceChunkIds.delete(documentId)
  sourceDocumentEpochs.set(documentId, currentSourceEpoch(documentId) + 1)
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
