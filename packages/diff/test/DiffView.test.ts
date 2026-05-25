import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { EditorTheme } from '@editor/core/rendering'
import { createEmptySyntaxResult } from '@editor/core/syntax'
import { createTextDiff, DiffView } from '../src'
import { diffSyntaxBackend, projectDiffSyntaxTokens } from '../src/DiffView'
import type {
  DiffFile,
  DiffSplitHandleContext,
  DiffSplitPaneOptions,
  DiffSyntaxBackend,
} from '../src'

beforeAll(() => {
  installHighlightPolyfill()
})

describe('DiffView split panes', () => {
  it('renders a resizable handle between old and new panes', () => {
    const { container } = renderDiffView()
    const split = querySplit(container)
    const children = Array.from(split.children)
    const handle = children[1] as HTMLElement | undefined

    expect(children).toHaveLength(3)
    expect(children[0]?.classList.contains('editor-diff-pane-old')).toBe(true)
    expect(handle?.matches('[data-editor-pane-handle]')).toBe(true)
    expect(handle?.getAttribute('role')).toBe('separator')
    expect(children[2]?.classList.contains('editor-diff-pane-new')).toBe(true)
  })

  it('mounts custom split handles with file-aware context', () => {
    const createHandle = vi.fn((context: DiffSplitHandleContext) => {
      const handle = context.document.createElement('div')
      handle.className = 'custom-diff-handle'
      return handle
    })
    const { container } = renderDiffView({ createHandle })

    expect(createHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        beforePaneId: 'old',
        afterPaneId: 'new',
        file: expect.objectContaining({ path: 'note.txt' }),
        orientation: 'horizontal',
      }),
    )
    expect(container.querySelector('.custom-diff-handle')).not.toBeNull()
    expect(container.querySelector('.editor-diff-split-handle')).toBeNull()
  })

  it('removes the handle when switching to stacked mode', () => {
    const { container, diffView } = renderDiffView()

    expect(container.querySelector('[data-editor-pane-handle]')).not.toBeNull()

    diffView.setMode('stacked')

    expect(container.querySelector('[data-editor-pane-handle]')).toBeNull()
    expect(container.querySelector('.editor-diff-split')).toBeNull()
    expect(container.querySelector('.editor-diff-pane-stacked')).not.toBeNull()
  })

  it('reveals next and previous hunks with wrapping', () => {
    const { diffView } = renderDiffView({ file: multiHunkDiff() })

    expect(diffView.getCurrentHunk()?.index).toBe(0)
    expect(diffView.revealNextHunk()).toBe(true)
    expect(diffView.getCurrentHunk()?.index).toBe(1)
    expect(diffView.revealNextHunk()).toBe(false)
    expect(diffView.revealNextHunk({ wrap: true })).toBe(true)
    expect(diffView.getCurrentHunk()?.index).toBe(0)
    expect(diffView.revealPreviousHunk({ wrap: true })).toBe(true)
    expect(diffView.getCurrentHunk()?.index).toBe(1)
  })

  it('toggles expandable hunk rows from gutter clicks', () => {
    const { container } = renderDiffView({
      file: prefixSkippedDiff(),
      mode: 'stacked',
    })
    const pane = queryPane(container, 'stacked')
    const view = queryVirtualizedView(pane)

    expect(pane.textContent).toContain('Show 2 unmodified lines')

    moveVirtualizedGutter(view, 0)
    expect(view.style.cursor).toBe('pointer')

    clickVirtualizedGutter(view, 0)

    expect(pane.textContent).toContain('Hide 2 unmodified lines')
    expect(pane.textContent).toContain('alpha')
    expect(pane.textContent).toContain('beta')

    view.dispatchEvent(pointerEvent('mouseleave', 0))
    expect(view.style.cursor).toBe('')
  })

  it('applies configured editor theme variables to panes', () => {
    const { container } = renderDiffView({
      theme: {
        foregroundColor: '#abcdef',
        syntax: { keyword: '#123456' },
      },
    })
    const pane = container.querySelector<HTMLElement>('.editor-diff-text')

    expect(pane?.style.getPropertyValue('--editor-foreground')).toBe('#abcdef')
    expect(pane?.style.getPropertyValue('--editor-syntax-keyword')).toBe('#123456')
  })

  it('projects full-file syntax tokens into split diff rows', () => {
    const tokens = projectDiffSyntaxTokens({
      rows: [
        {
          newLineNumber: 2,
          oldLineNumber: 2,
          text: 'beta',
          type: 'context',
        },
      ],
      side: 'old',
      sources: [
        {
          lineStarts: [0, 6, 11],
          side: 'old',
          tokens: [{ start: 6, end: 10, style: { color: 'red' } }],
        },
      ],
    })

    expect(tokens).toEqual([
      {
        start: 0,
        end: 4,
        style: { color: 'red' },
      },
    ])
  })

  it('projects stacked rows from old and new full-file token streams', () => {
    const tokens = projectDiffSyntaxTokens({
      rows: [
        {
          oldLineNumber: 1,
          text: 'old',
          type: 'deletion',
        },
        {
          newLineNumber: 1,
          text: 'new',
          type: 'addition',
        },
      ],
      side: 'stacked',
      sources: [
        {
          lineStarts: [0],
          side: 'old',
          tokens: [{ start: 0, end: 3, style: { color: 'red' } }],
        },
        {
          lineStarts: [0],
          side: 'new',
          tokens: [{ start: 0, end: 3, style: { color: 'blue' } }],
        },
      ],
    })

    expect(tokens).toEqual([
      { start: 0, end: 3, style: { color: 'red' } },
      { start: 4, end: 7, style: { color: 'blue' } },
    ])
  })

  it('passes full file text to the tree-sitter syntax backend', async () => {
    const parsedTexts: string[] = []
    const syntaxBackend = createRecordingSyntaxBackend(parsedTexts)

    renderDiffView({
      syntaxBackend,
      syntaxHighlight: true,
    })

    await flushPromises()

    expect(parsedTexts).toContain('one\ntwo\n')
  })

  it('defaults syntax highlighting to tree-sitter instead of shiki', () => {
    expect(diffSyntaxBackend({})).toEqual({ kind: 'tree-sitter' })
    expect(diffSyntaxBackend({ theme: { backgroundColor: '#ffffff' } })).toEqual({
      kind: 'tree-sitter',
    })
    expect(
      diffSyntaxBackend({
        syntaxBackend: { kind: 'shiki', shikiTheme: 'github-light' },
        theme: { backgroundColor: '#ffffff' },
      }),
    ).toEqual({ kind: 'shiki', shikiTheme: 'github-light' })
  })
})

type RenderDiffViewOptions = {
  readonly createHandle?: DiffSplitPaneOptions['createHandle']
  readonly file?: DiffFile
  readonly mode?: 'split' | 'stacked'
  readonly syntaxBackend?: DiffSyntaxBackend
  readonly syntaxHighlight?: boolean
  readonly theme?: EditorTheme | null
}

function renderDiffView(options: RenderDiffViewOptions = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const diffView = new DiffView(container, {
    mode: options.mode,
    showFileList: false,
    syntaxBackend: options.syntaxBackend,
    splitPane: {
      createHandle: options.createHandle,
    },
    syntaxHighlight: options.syntaxHighlight ?? false,
    theme: options.theme,
  })
  diffView.setFiles([options.file ?? singleHunkDiff()])
  return { container, diffView }
}

function singleHunkDiff() {
  return createTextDiff({
    oldFile: { path: 'note.txt', text: 'one\ntwo\n' },
    newFile: { path: 'note.txt', text: 'one\nTWO\n' },
  })
}

function multiHunkDiff() {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.txt', text: 'one\ntwo\nthree\nfour\nfive\nsix\n' },
    newFile: { path: 'note.txt', text: 'ONE\ntwo\nthree\nFOUR\nfive\nsix\n' },
  })
}

function prefixSkippedDiff() {
  return createTextDiff({
    contextLines: 0,
    oldFile: { path: 'note.txt', text: 'alpha\nbeta\ngamma\n' },
    newFile: { path: 'note.txt', text: 'alpha\nbeta\nGAMMA\n' },
  })
}

function querySplit(container: HTMLElement): HTMLElement {
  const split = container.querySelector<HTMLElement>('.editor-diff-split')
  if (!split) throw new Error('Expected split diff')
  return split
}

function queryPane(container: HTMLElement, side: 'old' | 'new' | 'stacked'): HTMLElement {
  const pane = container.querySelector<HTMLElement>(`.editor-diff-pane-${side}`)
  if (!pane) throw new Error(`Expected ${side} diff pane`)
  return pane
}

function queryVirtualizedView(container: HTMLElement): HTMLElement {
  const view = container.querySelector<HTMLElement>('.editor-virtualized')
  if (!view) throw new Error('Expected virtualized diff view')
  return view
}

function clickVirtualizedGutter(view: HTMLElement, y: number): void {
  view.dispatchEvent(pointerEvent('mousedown', y))
  view.dispatchEvent(pointerEvent('click', y))
}

function moveVirtualizedGutter(view: HTMLElement, y: number): void {
  view.dispatchEvent(pointerEvent('mousemove', y))
}

function pointerEvent(type: string, clientY: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientY,
    detail: 1,
  })
}

function createRecordingSyntaxBackend(parsedTexts: string[]): DiffSyntaxBackend {
  return {
    kind: 'tree-sitter',
    provider: {
      createSession(options) {
        parsedTexts.push(options.fullText)
        return {
          applyChange: async () => emptySyntaxResult(),
          dispose: () => undefined,
          getResult: () => emptySyntaxResult(),
          getSnapshotVersion: () => 0,
          getTokens: () => [],
          refresh: async () => emptySyntaxResult(),
        }
      },
    },
  }
}

function emptySyntaxResult() {
  return createEmptySyntaxResult()
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

type HighlightConstructor = new (...ranges: AbstractRange[]) => Highlight

class TestHighlight {
  private readonly ranges = new Set<AbstractRange>()

  public constructor(...ranges: AbstractRange[]) {
    for (const range of ranges) this.ranges.add(range)
  }

  public add(range: AbstractRange): this {
    this.ranges.add(range)
    return this
  }

  public clear(): void {
    this.ranges.clear()
  }

  public delete(range: AbstractRange): boolean {
    return this.ranges.delete(range)
  }
}

function installHighlightPolyfill(): void {
  const global = globalThis as typeof globalThis & {
    Highlight?: HighlightConstructor
  }
  if (global.Highlight) return
  global.Highlight = TestHighlight as unknown as HighlightConstructor
}
