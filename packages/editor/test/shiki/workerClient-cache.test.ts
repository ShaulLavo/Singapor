import { afterEach, describe, expect, it, vi } from 'vitest'

type WorkerClientModule = typeof import('../../src/shiki/workerClient')

type FakeWorkerRequest = {
  readonly id: number
  readonly payload: { readonly theme?: string; readonly type: string }
}

const fakeWorkers: FakeWorker[] = []
let currentClient: WorkerClientModule | null = null

class FakeWorker {
  public static autoResolve = true

  public onmessage: ((event: MessageEvent) => void) | null = null
  public onerror: ((event: ErrorEvent) => void) | null = null
  public readonly messages: FakeWorkerRequest[] = []
  private terminated = false

  public constructor() {
    fakeWorkers.push(this)
  }

  public postMessage(message: FakeWorkerRequest): void {
    this.messages.push(message)
    if (FakeWorker.autoResolve) queueMicrotask(() => this.resolveRequest(message))
  }

  public terminate(): void {
    this.terminated = true
  }

  public get isTerminated(): boolean {
    return this.terminated
  }

  public resolveRequest(message: FakeWorkerRequest): void {
    if (this.terminated) return

    this.onmessage?.({
      data: {
        id: message.id,
        ok: true,
        result: { theme: { backgroundColor: message.payload.theme } },
      },
    } as MessageEvent)
  }
}

describe('Shiki worker client theme cache', () => {
  afterEach(async () => {
    FakeWorker.autoResolve = true
    await currentClient?.disposeShikiWorker()
    currentClient = null
    fakeWorkers.length = 0
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('shares in-flight and resolved theme requests', async () => {
    const client = await loadWorkerClient()
    const first = client.loadShikiTheme({ theme: 'github-dark' })
    const second = client.loadShikiTheme({ theme: 'github-dark' })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { backgroundColor: 'github-dark' },
      { backgroundColor: 'github-dark' },
    ])
    await client.loadShikiTheme({ theme: 'github-dark' })

    expect(themeRequests()).toHaveLength(1)
  }, 20_000)

  it('clears theme cache when the worker is disposed', async () => {
    const client = await loadWorkerClient()

    await client.loadShikiTheme({ theme: 'github-dark' })
    await client.disposeShikiWorker()
    await client.loadShikiTheme({ theme: 'github-dark' })

    expect(themeRequests()).toHaveLength(2)
  }, 20_000)

  it('exposes owner lifecycle and cache accounting', async () => {
    const client = await loadWorkerClient()
    const owner = client.createShikiWorkerOwner()

    expect(owner.inspect()).toMatchObject({
      lifecycle: 'idle',
      pendingRequests: 0,
      cache: { themeRequests: 0 },
      workerGeneration: 0,
    })

    await owner.loadTheme({ theme: 'github-dark' })

    expect(owner.inspect()).toMatchObject({
      lifecycle: 'ready',
      pendingRequests: 0,
      cache: { themeRequests: 1 },
      workerGeneration: 1,
      lastError: null,
    })

    await owner.dispose()

    expect(owner.inspect()).toMatchObject({
      lifecycle: 'disposed',
      pendingRequests: 0,
      cache: { themeRequests: 0 },
      workerGeneration: 1,
    })
  }, 20_000)

  it('creates a fresh worker after a worker error rejects in-flight requests', async () => {
    FakeWorker.autoResolve = false
    const client = await loadWorkerClient()
    const theme = client.loadShikiTheme({ theme: 'github-dark' })
    const firstWorker = fakeWorkerAt(0)

    firstWorker.onerror?.({ message: 'boom' } as ErrorEvent)

    await expect(theme).rejects.toThrow('boom')
    expect(firstWorker.isTerminated).toBe(true)

    FakeWorker.autoResolve = true
    await expect(client.loadShikiTheme({ theme: 'github-dark' })).resolves.toEqual({
      backgroundColor: 'github-dark',
    })

    expect(fakeWorkers).toHaveLength(2)
  }, 20_000)
})

async function loadWorkerClient(): Promise<WorkerClientModule> {
  vi.resetModules()
  fakeWorkers.length = 0
  vi.stubGlobal('Worker', FakeWorker)
  currentClient = await import('../../src/shiki/workerClient')
  return currentClient
}

function themeRequests(): FakeWorkerRequest[] {
  return fakeWorkers.flatMap((worker) =>
    worker.messages.filter((message) => message.payload.type === 'theme'),
  )
}

function fakeWorkerAt(index: number): FakeWorker {
  const worker = fakeWorkers[index]
  if (!worker) throw new Error(`Expected fake worker at index ${index}`)
  return worker
}
