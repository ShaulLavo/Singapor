import { documentSessionChangeTextSnapshot, type DocumentSessionChange } from '../documentSession'
import { createDocumentTextSnapshot, type DocumentTextSnapshot } from '../documentTextSnapshot'
import { applyBatchToPieceTable } from '../pieceTable/edits'
import { pieceTableSnapshotsHaveSameText } from '../pieceTable/reads'
import type { PieceTableSnapshot } from '../pieceTable/pieceTableTypes'
import type {
  EditorHighlightResult,
  EditorHighlighterSession,
  EditorHighlighterSessionOptions,
} from '../plugins'
import type { EditorTheme } from '../theme'
import type {
  ShikiWorkerDocumentOptions,
  ShikiWorkerRequest,
  ShikiWorkerRequestPayload,
  ShikiWorkerResponse,
  ShikiWorkerResult,
} from './workerTypes'

export type ShikiHighlighterSessionOptions = Omit<
  EditorHighlighterSessionOptions,
  'textSnapshot'
> & {
  readonly textSnapshot?: DocumentTextSnapshot
  readonly lang: string
  readonly theme: string
  readonly langs?: readonly string[]
  readonly themes?: readonly string[]
}

export type ShikiThemeOptions = {
  readonly theme: string
  readonly themes?: readonly string[]
}

type PendingRequest = {
  readonly resolve: (result: ShikiWorkerResult | undefined) => void
  readonly reject: (error: Error) => void
}

const supportsWorkers = (): boolean => typeof Worker !== 'undefined'

let worker: Worker | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, PendingRequest>()
const themeRequests = new Map<string, Promise<EditorTheme | null | undefined>>()

export const canUseShikiWorker = (): boolean => supportsWorkers()

export function createShikiHighlighterSession(
  options: ShikiHighlighterSessionOptions,
): EditorHighlighterSession | null {
  if (!canUseShikiWorker()) return null
  return new ShikiHighlighterSession(options)
}

export async function loadShikiTheme(
  options: ShikiThemeOptions,
): Promise<EditorTheme | null | undefined> {
  if (!canUseShikiWorker()) return undefined

  const key = shikiThemeRequestKey(options)
  const existing = themeRequests.get(key)
  if (existing) return existing

  const request = requestShikiTheme(options).catch((error) => {
    themeRequests.delete(key)
    throw error
  })
  themeRequests.set(key, request)
  return request
}

export async function disposeShikiWorker(): Promise<void> {
  if (!worker) return

  try {
    await postRequest({ type: 'dispose' })
  } finally {
    worker.terminate()
    worker = null
    themeRequests.clear()
    rejectPendingRequests(new Error('Shiki worker disposed'))
  }
}

class ShikiHighlighterSession implements EditorHighlighterSession {
  private readonly documentId: string
  private readonly lang: string
  private readonly theme: string
  private readonly langs: readonly string[]
  private readonly themes: readonly string[]
  private snapshot: PieceTableSnapshot
  private textSnapshot: DocumentTextSnapshot
  private opened = false
  private disposed = false
  private task: Promise<void> = Promise.resolve()

  public constructor(options: ShikiHighlighterSessionOptions) {
    this.documentId = options.documentId
    this.lang = options.lang
    this.theme = options.theme
    this.langs = options.langs ?? []
    this.themes = options.themes ?? []
    this.snapshot = options.snapshot
    this.textSnapshot =
      options.textSnapshot ?? createDocumentTextSnapshot(options.snapshot, options.text)
  }

  public async refresh(
    snapshot: ShikiHighlighterSessionOptions['snapshot'],
    text?: string,
  ): Promise<EditorHighlightResult> {
    return this.enqueueRequest(async () => {
      const textSnapshot = createDocumentTextSnapshot(snapshot, text)
      const documentText = textSnapshot.getText()
      const result = await postRequest({
        type: 'open',
        ...this.documentOptions(documentText),
        text: documentText,
      })

      this.snapshot = snapshot
      this.textSnapshot = textSnapshot
      this.opened = true
      this.disposed = false
      return { tokens: result?.tokens ?? [], theme: result?.theme }
    })
  }

  public async applyChange(change: DocumentSessionChange): Promise<EditorHighlightResult> {
    return this.enqueueRequest(async () => {
      const nextTextSnapshot = documentSessionChangeTextSnapshot(change)
      const payload = this.editPayloadForChange(change, nextTextSnapshot)
      const result = await postRequest(payload)
      this.snapshot = change.snapshot
      this.textSnapshot = nextTextSnapshot
      this.opened = true
      this.disposed = false
      return { tokens: result?.tokens ?? [], theme: result?.theme }
    })
  }

  public dispose(): void {
    this.disposed = true
    this.opened = false
    void postRequest({ type: 'disposeDocument', documentId: this.documentId }).catch(
      () => undefined,
    )
  }

  private enqueueRequest(
    run: () => Promise<EditorHighlightResult>,
  ): Promise<EditorHighlightResult> {
    const result = this.task.then(run, run)
    this.task = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private editPayloadForChange(
    change: DocumentSessionChange,
    nextTextSnapshot: DocumentTextSnapshot,
  ): ShikiWorkerRequestPayload {
    const edit = incrementalEditForChange(this.snapshot, change)
    if (edit && this.opened && !this.disposed) {
      return {
        type: 'edit',
        ...this.documentOptions(),
        edit,
      }
    }

    const text = nextTextSnapshot.getText()
    const fallbackEdit = createTextDiffEdit(this.textSnapshot.getText(), text) ?? undefined
    return {
      type: 'edit',
      ...this.documentOptions(text),
      edit: fallbackEdit,
    }
  }

  private documentOptions(text?: string): ShikiWorkerDocumentOptions {
    return {
      documentId: this.documentId,
      lang: this.lang,
      theme: this.theme,
      text,
      langs: this.langs,
      themes: this.themes,
    }
  }
}

const getWorker = (): Worker | null => {
  if (!supportsWorkers()) return null
  if (worker) return worker

  worker = new Worker(new URL('./shiki.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = handleWorkerMessage
  worker.onerror = handleWorkerError
  return worker
}

const postRequest = (
  payload: ShikiWorkerRequestPayload,
): Promise<ShikiWorkerResult | undefined> => {
  const handle = getWorker()
  if (!handle) return Promise.resolve(undefined)

  const id = nextRequestId++
  const request: ShikiWorkerRequest = { id, payload }

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    handle.postMessage(request)
  })
}

const handleWorkerMessage = (event: MessageEvent<ShikiWorkerResponse>): void => {
  const response = event.data
  const pending = pendingRequests.get(response.id)
  if (!pending) return

  pendingRequests.delete(response.id)
  if (response.ok) {
    pending.resolve(response.result)
    return
  }

  pending.reject(new Error(response.error))
}

const handleWorkerError = (event: ErrorEvent): void => {
  themeRequests.clear()
  rejectPendingRequests(new Error(event.message || 'Shiki worker failed'))
}

const rejectPendingRequests = (error: Error): void => {
  for (const request of pendingRequests.values()) request.reject(error)
  pendingRequests.clear()
}

export const createTextDiffEdit = (previousText: string, nextText: string) => {
  if (previousText === nextText) return null

  let start = 0
  const maxPrefixLength = Math.min(previousText.length, nextText.length)
  while (start < maxPrefixLength && previousText[start] === nextText[start]) start += 1

  let previousEnd = previousText.length
  let nextEnd = nextText.length
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd -= 1
    nextEnd -= 1
  }

  return {
    from: start,
    to: previousEnd,
    text: nextText.slice(start, nextEnd),
  }
}

const incrementalEditForChange = (snapshot: PieceTableSnapshot, change: DocumentSessionChange) => {
  if (change.edits.length !== 1) return null

  try {
    if (
      !pieceTableSnapshotsHaveSameText(
        applyBatchToPieceTable(snapshot, change.edits),
        change.snapshot,
      )
    ) {
      return null
    }
  } catch {
    return null
  }

  return change.edits[0] ?? null
}

async function requestShikiTheme(
  options: ShikiThemeOptions,
): Promise<EditorTheme | null | undefined> {
  const result = await postRequest({
    type: 'theme',
    theme: options.theme,
    themes: options.themes ?? [],
  })
  return result?.theme
}

function shikiThemeRequestKey(options: ShikiThemeOptions): string {
  return JSON.stringify({
    theme: options.theme,
    themes: (options.themes ?? []).toSorted(),
  })
}
