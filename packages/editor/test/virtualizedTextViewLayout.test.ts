import { describe, expect, it } from 'vitest'
import type { BlockRow, DisplayRow, DisplayTextRow } from '../src/displayTransforms'
import { createStringTextSnapshot } from '../src/documentTextSnapshot'
import type { FixedRowVirtualizerSnapshot } from '../src/virtualization/fixedRowVirtualizer'
import { createLineStartOffsetIndex } from '../src/virtualization/lineStartIndex'
import type { VirtualizedTextViewInternal } from '../src/virtualization/virtualizedTextViewInternals'
import {
  applySameLineTextLayout,
  bufferLineStartOffset,
  hasVariableRows,
  materializeLineStarts,
  rowHeight,
  rowForOffset,
  rowForViewportY,
  rowSizes,
  rowTop,
  scrollableHeight,
  virtualRowForBufferRow,
} from '../src/virtualization/virtualizedTextViewLayout'

describe('virtualized text view layout', () => {
  it('maps plain offsets without scanning every display row', () => {
    const lineCount = 100_000
    const lineStarts = Array.from({ length: lineCount }, (_value, row) => row * 2)
    const displayRows = lineStarts.map((start, row) => textRow(row, row, start, start + 1))
    const view = layoutView({
      text: 'x'.repeat(lineStarts.at(-1)! + 1),
      lineStarts,
      displayRows,
      foldMap: null,
      blockRows: [],
      wrapEnabled: false,
    })

    const lastRow = lineCount - 1
    const offsetRow = withThrowingArrayFind(() => rowForOffset(view, lineStarts[lastRow]!))
    const virtualRow = withThrowingArrayFind(() => virtualRowForBufferRow(view, lastRow))

    expect(offsetRow).toBe(lastRow)
    expect(virtualRow).toBe(lastRow)
  })

  it('keeps wrapped row boundary offsets on the preceding segment', () => {
    const sourceText = 'abcdefghij'
    const view = layoutView({
      text: sourceText,
      lineStarts: [0],
      displayRows: [
        textRow(0, 0, 0, 5, 'abcde', sourceText, 0),
        textRow(1, 0, 5, 10, 'fghij', sourceText, 1),
      ],
      foldMap: null,
      blockRows: [],
      wrapEnabled: true,
    })

    expect(rowForOffset(view, 5)).toBe(0)
    expect(rowForOffset(view, 6)).toBe(1)
  })

  it('skips block rows when mapping an offset to text', () => {
    const blockRows: BlockRow[] = [
      { id: 'before-first', anchorBufferRow: 0, placement: 'before', heightRows: 1 },
    ]
    const view = layoutView({
      text: 'abc',
      lineStarts: [0],
      displayRows: [blockRow(0, 0, 'before'), textRow(1, 0, 0, 3, 'abc')],
      foldMap: null,
      blockRows,
      wrapEnabled: false,
    })

    expect(rowForOffset(view, 0)).toBe(1)
    expect(virtualRowForBufferRow(view, 0)).toBe(1)
  })

  it('detects fixed row heights without scanning display rows', () => {
    const displayRows = throwingDisplayRows([textRow(0, 0, 0, 1)])
    const view = layoutView({
      text: 'x',
      lineStarts: [0],
      displayRows,
      foldMap: null,
      blockRows: [],
      wrapEnabled: false,
    })

    expect(hasVariableRows(view)).toBe(false)
    expect(rowSizes(view)).toBeUndefined()
  })

  it('positions fixed rows with row gaps without treating them as variable rows', () => {
    const view = layoutView({
      text: 'a\nb\nc',
      lineStarts: [0, 2, 4],
      displayRows: [textRow(0, 0, 0, 1), textRow(1, 1, 2, 3), textRow(2, 2, 4, 5)],
      foldMap: null,
      blockRows: [],
      wrapEnabled: false,
    })
    view.rowGap = 4

    expect(hasVariableRows(view)).toBe(false)
    expect(rowSizes(view)).toBeUndefined()
    expect(rowHeight(view, 0)).toBe(20)
    expect(rowTop(view, 2)).toBe(48)
  })

  it('detects variable block heights from block row config', () => {
    const blockRows: BlockRow[] = [
      { id: 'panel', anchorBufferRow: 0, placement: 'after', heightRows: 2 },
    ]
    const view = layoutView({
      text: 'x',
      lineStarts: [0],
      displayRows: [textRow(0, 0, 0, 1), blockRow(1, 0, 'after', 2)],
      foldMap: null,
      blockRows,
      wrapEnabled: false,
    })

    expect(hasVariableRows(view)).toBe(true)
    expect(rowSizes(view)).toEqual([20, 40])
    view.rowGap = 4
    expect(rowTop(view, 1)).toBe(24)
  })

  it('caches variable row sizes for repeated geometry lookups', () => {
    const blockRows: BlockRow[] = [
      { id: 'panel', anchorBufferRow: 0, placement: 'after', heightRows: 2 },
    ]
    const displayRows = [textRow(0, 0, 0, 1), blockRow(1, 0, 'after', 2), textRow(2, 1, 2, 3)]
    const view = layoutView({
      text: 'x\ny',
      lineStarts: [0, 2],
      displayRows,
      foldMap: null,
      blockRows,
      wrapEnabled: false,
    })
    view.rowGap = 4

    const sizes = rowSizes(view)
    expect(sizes).toEqual([20, 40, 20])

    guardArrayIndexRead(displayRows, 0, 'unexpected row size rebuild')
    guardArrayIndexRead(displayRows, 1, 'unexpected row size rebuild')
    guardArrayIndexRead(displayRows, 2, 'unexpected row size rebuild')

    expect(rowSizes(view)).toBe(sizes)
    expect(rowTop(view, 2)).toBe(68)
    expect(rowHeight(view, 1)).toBe(40)
    expect(rowForViewportY(view, 22)).toBe(1)
  })

  it('uses measured row metrics without re-entering the virtualizer', () => {
    const view = layoutView({
      text: 'x',
      lineStarts: [0],
      displayRows: [textRow(0, 0, 0, 1)],
      foldMap: null,
      blockRows: [],
      wrapEnabled: false,
    })

    expect(rowHeight(view, 0)).toBe(20)
    expect(scrollableHeight(view, fixedSnapshot({ totalSize: 20, viewportHeight: 60 }))).toBe(60)
  })

  it('applies same-line layout without rewriting suffix rows', () => {
    const lineStarts = guardedSuffixLineStarts([0, 2, 4, 6])
    const displayRows = guardedSuffixDisplayRows([
      textRow(0, 0, 0, 1, 'a'),
      textRow(1, 1, 2, 3, 'b'),
      textRow(2, 2, 4, 5, 'c'),
      textRow(3, 3, 6, 7, 'd'),
    ])
    const view = layoutView({
      text: 'a\nb\nc\nd',
      lineStarts,
      displayRows,
      foldMap: null,
      blockRows: [],
      wrapEnabled: false,
    })

    applySameLineTextLayout(
      view,
      { rowIndex: 0, localFrom: 1, deleteLength: 0, text: 'X' },
      createStringTextSnapshot('aX\nb\nc\nd'),
    )

    expect(view.displayRows[0]).toMatchObject({ text: 'aX' })
    expect(bufferLineStartOffset(view, 1)).toBe(3)
    expect(rowForOffset(view, 3)).toBe(1)
  })

  it('accumulates same-line suffix shifts across later row edits', () => {
    const view = layoutView({
      text: 'a\nb\nc',
      lineStarts: [0, 2, 4],
      displayRows: [textRow(0, 0, 0, 1, 'a'), textRow(1, 1, 2, 3, 'b'), textRow(2, 2, 4, 5, 'c')],
      foldMap: null,
      blockRows: [],
      wrapEnabled: false,
    })

    applySameLineTextLayout(
      view,
      { rowIndex: 0, localFrom: 1, deleteLength: 0, text: 'X' },
      createStringTextSnapshot('aX\nb\nc'),
    )
    applySameLineTextLayout(
      view,
      { rowIndex: 1, localFrom: 1, deleteLength: 0, text: 'Y' },
      createStringTextSnapshot('aX\nbY\nc'),
    )

    expect(view.displayRows[1]).toMatchObject({ text: 'bY' })
    expect(bufferLineStartOffset(view, 1)).toBe(3)
    expect(bufferLineStartOffset(view, 2)).toBe(6)
    expect(rowForOffset(view, 6)).toBe(2)
  })

  it('creates and clears line-start suffix shifts lazily', () => {
    const view = layoutView({
      text: 'a\nb\nc',
      lineStarts: [0, 2, 4],
      displayRows: [textRow(0, 0, 0, 1, 'a'), textRow(1, 1, 2, 3, 'b'), textRow(2, 2, 4, 5, 'c')],
      foldMap: null,
      blockRows: [],
      wrapEnabled: false,
    })

    expect(view.lineStartOffsetIndex).toBeNull()

    applySameLineTextLayout(
      view,
      { rowIndex: 0, localFrom: 1, deleteLength: 0, text: 'X' },
      createStringTextSnapshot('aX\nb\nc'),
    )

    expect(view.lineStartOffsetIndex?.dirty).toBe(true)
    expect(materializeLineStarts(view)).toEqual([0, 3, 5])
    expect(view.lineStartOffsetIndex).toBeNull()
  })
})

describe('line start offset index', () => {
  it('tracks suffix shifts and materializes them in row order', () => {
    const index = createLineStartOffsetIndex(4)

    index.addSuffix(1, 2)
    index.addSuffix(3, -1)
    index.addSuffix(1, 3)

    expect(index.dirty).toBe(true)
    expect(index.offsetAt(0)).toBe(0)
    expect(index.offsetAt(1)).toBe(5)
    expect(index.offsetAt(3)).toBe(4)
    expect(index.materialize([0, 2, 4, 6])).toEqual([0, 7, 9, 10])
  })
})

type LayoutFields = Pick<
  VirtualizedTextViewInternal,
  'text' | 'lineStarts' | 'displayRows' | 'foldMap' | 'blockRows' | 'wrapEnabled'
>

function layoutView(fields: LayoutFields): VirtualizedTextViewInternal {
  return {
    ...fields,
    scrollElement: { scrollTop: 0 } as HTMLDivElement,
    textLength: fields.text.length,
    lineStartOffsetIndex: null,
    injectedTextRows: [],
    virtualizer: throwingVirtualizer(),
    metrics: { rowHeight: 20, characterWidth: 8 },
    rowGap: 0,
  } as VirtualizedTextViewInternal
}

function throwingVirtualizer(): VirtualizedTextViewInternal['virtualizer'] {
  return {
    getSnapshot: () => {
      throw new Error('unexpected virtualizer snapshot read')
    },
  } as VirtualizedTextViewInternal['virtualizer']
}

function fixedSnapshot(
  fields: Pick<FixedRowVirtualizerSnapshot, 'totalSize' | 'viewportHeight'>,
): FixedRowVirtualizerSnapshot {
  const scrollHeight = Math.max(fields.totalSize, fields.viewportHeight)
  return {
    scrollTop: 0,
    scrollLeft: 0,
    viewportWidth: 0,
    viewportHeight: fields.viewportHeight,
    borderBoxWidth: 0,
    borderBoxHeight: 0,
    totalSize: fields.totalSize,
    scrollHeight,
    nativeScrollHeight: scrollHeight,
    nativeScrollTop: 0,
    visibleRange: { start: 0, end: 1 },
    virtualItems: [],
  }
}

function textRow(
  index: number,
  bufferRow: number,
  startOffset: number,
  endOffset: number,
  text = 'x',
  sourceText = text,
  wrapSegment = 0,
): DisplayTextRow {
  return {
    kind: 'text',
    source: 'document',
    index,
    bufferRow,
    startOffset,
    endOffset,
    text,
    sourceText,
    sourceStartColumn: startOffset,
    sourceEndColumn: endOffset,
    wrapSegment,
  }
}

function blockRow(
  index: number,
  anchorBufferRow: number,
  placement: 'before' | 'after',
  heightRows = 1,
): DisplayRow {
  return {
    kind: 'block',
    id: `block-${index}`,
    index,
    anchorBufferRow,
    placement,
    unitIndex: 0,
    heightRows,
    startOffset: 0,
    endOffset: 0,
    text: '',
  }
}

function throwingDisplayRows(rows: DisplayRow[]): DisplayRow[] {
  return Object.assign(rows, {
    map: throwingDisplayRowScan,
    some: throwingDisplayRowScan,
  })
}

function guardedSuffixLineStarts(lineStarts: number[]): number[] {
  for (let index = 1; index < lineStarts.length; index += 1) {
    guardArrayIndexWrite(lineStarts, index, 'unexpected suffix line start rewrite')
  }

  return lineStarts
}

function guardedSuffixDisplayRows(rows: DisplayRow[]): DisplayRow[] {
  for (let index = 1; index < rows.length; index += 1) {
    guardArrayIndexRead(rows, index, 'unexpected suffix display row read')
  }

  return rows
}

function guardArrayIndexWrite<T>(items: T[], index: number, message: string): void {
  const value = items[index]
  Object.defineProperty(items, index, {
    configurable: true,
    get: () => value,
    set: () => {
      throw new Error(message)
    },
  })
}

function guardArrayIndexRead<T>(items: T[], index: number, message: string): void {
  Object.defineProperty(items, index, {
    configurable: true,
    get: () => {
      throw new Error(message)
    },
    set: (next) => {
      throw new Error(`${message}: ${String(next)}`)
    },
  })
}

function throwingDisplayRowScan(): never {
  throw new Error('unexpected display row scan')
}

function withThrowingArrayFind<T>(run: () => T): T {
  const originalFind = Array.prototype.find
  Array.prototype.find = throwingArrayFind as typeof Array.prototype.find

  try {
    return run()
  } finally {
    Array.prototype.find = originalFind
  }
}

function throwingArrayFind(): never {
  throw new Error('unexpected linear Array.find')
}
