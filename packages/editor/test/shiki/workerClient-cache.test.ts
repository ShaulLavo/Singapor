import { afterEach, describe, expect, it, vi } from 'vitest'

type WorkerClientModule = typeof import('../../src/shiki/workerClient')

type FakeWorkerRequest = {
  readonly id: number
  readonly payload: { readonly theme?: string; readonly type: string }
}

const fakeWorkers: FakeWorker[] = []
let currentClient: WorkerClientModule | null = null

class FakeWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null
  public onerror: ((event: ErrorEvent) => void) | null = null
  public readonly messages: FakeWorkerRequest[] = []
  private terminated = false

  public constructor() {
    fakeWorkers.push(this)
  }

  public postMessage(message: FakeWorkerRequest): void {
    this.messages.push(message)
    queueMicrotask(() => this.resolveRequest(message))
  }

  public terminate(): void {
    this.terminated = true
  }

  private resolveRequest(message: FakeWorkerRequest): void {
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
  })

  it('clears theme cache when the worker is disposed', async () => {
    const client = await loadWorkerClient()

    await client.loadShikiTheme({ theme: 'github-dark' })
    await client.disposeShikiWorker()
    await client.loadShikiTheme({ theme: 'github-dark' })

    expect(themeRequests()).toHaveLength(2)
  })
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
