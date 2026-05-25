import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { EditorGutterContribution, EditorPlugin, EditorPluginContext } from '../plugins'
import { setHighlightRegistry } from './runtime'
import { Editor } from './Editor'

type TestWindow = Window & typeof globalThis

const highlightRegistry = {
  set: () => undefined,
  delete: () => true,
}

describe('editor plugin lifecycle', () => {
  let cleanupDom: (() => void) | null = null

  beforeEach(() => {
    cleanupDom = installDom()
    setHighlightRegistry(highlightRegistry)
  })

  afterEach(() => {
    setHighlightRegistry(undefined)
    cleanupDom?.()
    cleanupDom = null
  })

  test('retains plugin identity across repeated setPlugins calls', () => {
    const editor = createEditor()
    const lifecycle = createLifecyclePlugin()

    editor.setPlugins([lifecycle.plugin])
    editor.setPlugins([lifecycle.plugin])

    expect(lifecycle.activations).toBe(1)
    expect(lifecycle.disposals).toBe(0)

    editor.setPlugins([])

    expect(lifecycle.disposals).toBe(1)
    editor.dispose()
  })

  test('uses one host context across plugin activations', () => {
    const editor = createEditor()
    const contexts: EditorPluginContext[] = []
    const first = createContextCapturePlugin(contexts)
    const second = createContextCapturePlugin(contexts)

    editor.setPlugins([first, second])

    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toBe(contexts[1])
    editor.dispose()
  })

  test('removePlugin force-removes managed and manual references', () => {
    const editor = createEditor()
    const lifecycle = createLifecyclePlugin()
    const lease = editor.addPlugin(lifecycle.plugin)

    editor.setPlugins([lifecycle.plugin])
    expect(editor.removePlugin(lifecycle.plugin)).toBe(true)
    lease.dispose()

    expect(lifecycle.activations).toBe(1)
    expect(lifecycle.disposals).toBe(1)
    editor.dispose()
  })

  test('late view contributions receive an initial document update', () => {
    const editor = createEditor()
    const updates: string[] = []
    const plugin: EditorPlugin = {
      activate: (context) =>
        context.registerViewContribution({
          createContribution: () => ({
            update: (_snapshot, kind) => updates.push(kind),
            dispose: () => undefined,
          }),
        }),
    }

    editor.addPlugin(plugin)

    expect(updates).toEqual(['document'])
    editor.dispose()
  })

  test('late gutter contributions attach and dispose mounted cells', () => {
    const editor = createEditor()
    const disposedCells: HTMLElement[] = []
    const contribution: EditorGutterContribution = {
      id: 'test-gutter',
      createCell: (document) => document.createElement('span'),
      width: () => 8,
      updateCell: () => undefined,
      disposeCell: (element) => disposedCells.push(element),
    }
    const plugin: EditorPlugin = {
      activate: (context) => context.registerGutterContribution(contribution),
    }

    const lease = editor.addPlugin(plugin)
    syncEditorViewport(editor, 320, 120)
    const cells = findGutterCells('test-gutter')

    expect(cells.length).toBeGreaterThan(0)

    lease.dispose()

    expect(disposedCells).toHaveLength(cells.length)
    expect(findGutterCells('test-gutter')).toHaveLength(0)
    editor.dispose()
  })
})

function createEditor(): Editor {
  const container = document.createElement('div')
  mockEditorViewport(container, 320, 120)
  document.body.appendChild(container)
  const editor = new Editor(container, { defaultText: 'one\ntwo' })
  mockEditorViewport(editorElement(editor), 320, 120)
  syncEditorViewport(editor, 320, 120)
  editor.setScrollPosition({ top: 0, left: 0 })
  return editor
}

function editorElement(editor: Editor): HTMLElement {
  return (editor as unknown as { readonly el: HTMLElement }).el
}

function syncEditorViewport(editor: Editor, width: number, height: number): void {
  const internals = editor as unknown as {
    readonly view: {
      setScrollMetrics(scrollTop: number, viewportHeight: number, viewportWidth: number): void
    }
  }
  internals.view.setScrollMetrics(0, height, width)
}

function mockEditorViewport(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: height })
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  })
}

function createLifecyclePlugin(): {
  readonly plugin: EditorPlugin
  readonly activations: number
  readonly disposals: number
} {
  const lifecycle = {
    activations: 0,
    disposals: 0,
  }
  const plugin: EditorPlugin = {
    activate: () => {
      lifecycle.activations += 1
      return {
        dispose: () => {
          lifecycle.disposals += 1
        },
      }
    },
  }

  return {
    plugin,
    get activations() {
      return lifecycle.activations
    },
    get disposals() {
      return lifecycle.disposals
    },
  }
}

function createContextCapturePlugin(contexts: EditorPluginContext[]): EditorPlugin {
  return {
    activate: (context) => {
      contexts.push(context)
    },
  }
}

function findGutterCells(id: string): HTMLElement[] {
  const matches: HTMLElement[] = []
  const elements = document.body.getElementsByTagName('*')
  for (const element of elements) {
    if (element instanceof HTMLElement && element.dataset.editorGutterContribution === id)
      matches.push(element)
  }

  return matches
}

function installDom(): () => void {
  const previous = captureDomGlobals()
  const window = new Window() as TestWindow
  Object.assign(window, { SyntaxError })

  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLDivElement: window.HTMLDivElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Node: window.Node,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  })
  Object.defineProperty(globalThis, 'Highlight', {
    configurable: true,
    value: class Highlight {
      constructor(..._ranges: AbstractRange[]) {}
    },
  })

  return () => restoreDomGlobals(previous)
}

function captureDomGlobals(): Record<string, unknown> {
  return Object.fromEntries(DOM_GLOBALS.map((key) => [key, globalThis[key]]))
}

function restoreDomGlobals(previous: Record<string, unknown>): void {
  for (const key of DOM_GLOBALS) restoreDomGlobal(key, previous[key])
}

function restoreDomGlobal(key: string, value: unknown): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key)
    return
  }

  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
  })
}

const DOM_GLOBALS = [
  'window',
  'document',
  'HTMLElement',
  'HTMLDivElement',
  'HTMLTextAreaElement',
  'Node',
  'DOMRect',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'Highlight',
] as const
