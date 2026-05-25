import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditorWorkScheduler, type EditorWorkEvent } from '../src/editor/workScheduler'

type Deferred<T> = {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('EditorWorkScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs only the latest delayed work for a key', () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const events: EditorWorkEvent[] = []
    const scheduler = new EditorWorkScheduler({ onEvent: (event) => events.push(event) })

    scheduler.schedule({
      key: 'editor.syntax.visibleRange',
      taskClass: 'viewport-derived',
      delayMs: 50,
      tags: { version: 1, viewport: '0:10' },
      run: () => calls.push('first'),
    })
    vi.advanceTimersByTime(25)
    scheduler.schedule({
      key: 'editor.syntax.visibleRange',
      taskClass: 'viewport-derived',
      delayMs: 50,
      tags: { version: 2, viewport: '10:20' },
      run: () => calls.push('second'),
    })

    vi.advanceTimersByTime(49)
    expect(calls).toEqual([])

    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['second'])
    expect(events.map((event) => event.type)).toEqual([
      'scheduled',
      'cancelled',
      'scheduled',
      'started',
      'completed',
    ])
    expect(events.at(-1)).toMatchObject({
      key: 'editor.syntax.visibleRange',
      priority: 'normal',
      tags: { version: 2, viewport: '10:20' },
    })
  })

  it('drops stale work before it starts', () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const events: EditorWorkEvent[] = []
    const scheduler = new EditorWorkScheduler({ onEvent: (event) => events.push(event) })

    scheduler.schedule({
      key: 'editor.features',
      taskClass: 'background-derived',
      delayMs: 10,
      tags: { version: 1 },
      isCurrent: (tags) => tags.version === 2,
      run: () => calls.push('stale'),
    })

    vi.advanceTimersByTime(10)
    expect(calls).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'dropped', reason: 'stale-before-start' })
  })

  it('cancels running async work when replacement is scheduled', async () => {
    const first = createDeferred<string>()
    const second = createDeferred<string>()
    const applied: string[] = []
    let firstSignal: AbortSignal | null = null
    const scheduler = new EditorWorkScheduler()

    scheduler.schedule({
      key: 'editor.syntax.document',
      taskClass: 'background-derived',
      run: (context) => {
        firstSignal = context.signal
        return first.promise
      },
      apply: (result) => applied.push(result),
    })
    scheduler.schedule({
      key: 'editor.syntax.document',
      taskClass: 'background-derived',
      run: () => second.promise,
      apply: (result) => applied.push(result),
    })

    expect(firstSignal?.aborted).toBe(true)
    first.resolve('first')
    await flushMicrotasks()
    expect(applied).toEqual([])

    second.resolve('second')
    await flushMicrotasks()
    expect(applied).toEqual(['second'])
  })

  it('aborts over-budget async work and suppresses the eventual result', async () => {
    vi.useFakeTimers()
    const deferred = createDeferred<string>()
    const applied: string[] = []
    const events: EditorWorkEvent[] = []
    let cancelled = false
    let signal: AbortSignal | null = null
    const scheduler = new EditorWorkScheduler({ onEvent: (event) => events.push(event) })

    scheduler.schedule({
      key: 'editor.syntax.warmRange',
      taskClass: 'idle-cache',
      budgetMs: 20,
      run: (context) => {
        signal = context.signal
        return deferred.promise
      },
      apply: (result) => applied.push(result),
      cancel: () => {
        cancelled = true
      },
    })

    vi.advanceTimersByTime(20)
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'timed-out', reason: 'budget-timeout' })

    deferred.resolve('late')
    await flushMicrotasks()
    expect(applied).toEqual([])
  })
})
