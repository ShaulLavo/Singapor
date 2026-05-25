import type { PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import {
  forEachPieceTableTextChunk,
  materializePieceTableFullText,
  readPieceTableTextRange,
} from './pieceTable/reads'
import {
  measureEditorPerformance,
  recordEditorPerformanceDiagnostic,
} from './editor/performanceDiagnostics'

export type TextSnapshot = {
  readonly length: number
  readRange(start: number, end: number): string
  materializeFullText(): string
  forEachTextChunk(visit: (text: string, start: number, end: number) => void): void
}

export type DocumentTextSnapshot = TextSnapshot & {
  readonly snapshot: PieceTableSnapshot
}

export function defineLazyFullTextProperty<TTarget extends { readonly textSnapshot: TextSnapshot }>(
  target: TTarget,
): TTarget & { readonly fullText: string } {
  let fullTextCache: string | undefined
  Object.defineProperty(target, 'fullText', {
    configurable: true,
    enumerable: true,
    get: () => {
      fullTextCache ??= target.textSnapshot.materializeFullText()
      return fullTextCache
    },
  })
  return target as TTarget & { readonly fullText: string }
}

export function createDocumentTextSnapshot(
  snapshot: PieceTableSnapshot,
  materializedText?: string,
): DocumentTextSnapshot {
  const retainedText = materializedText?.length === snapshot.length ? materializedText : undefined
  const materializeFullText = (): string => {
    if (retainedText !== undefined) {
      recordFullTextSnapshotRead('textSnapshot.materializeFullText', snapshot.length, true)
      return retainedText
    }

    return measureEditorPerformance(
      'textSnapshot.materializeFullText',
      () => materializePieceTableFullText(snapshot),
      () => fullTextSnapshotDetail(snapshot.length, false),
    )
  }

  return {
    snapshot,
    length: snapshot.length,
    materializeFullText,
    readRange: (start, end) => {
      if (retainedText !== undefined && start === 0 && end === snapshot.length) {
        recordFullTextSnapshotRead('textSnapshot.readRange', snapshot.length, true)
        return retainedText
      }

      if (start === 0 && end === snapshot.length) {
        return measureEditorPerformance(
          'textSnapshot.readRange',
          () => readPieceTableTextRange(snapshot, start, end),
          () => fullTextSnapshotDetail(snapshot.length, false),
        )
      }

      return readPieceTableTextRange(snapshot, start, end)
    },
    forEachTextChunk: (visit) => {
      if (retainedText !== undefined) {
        if (retainedText.length > 0) visit(retainedText, 0, retainedText.length)
        return
      }

      forEachPieceTableTextChunk(snapshot, visit)
    },
  }
}

export function createStringTextSnapshot(text: string): TextSnapshot {
  return {
    length: text.length,
    materializeFullText: () => text,
    readRange: (start, end) => text.slice(start, end),
    forEachTextChunk: (visit) => {
      if (text.length > 0) visit(text, 0, text.length)
    },
  }
}

function recordFullTextSnapshotRead(name: string, length: number, retained: boolean): void {
  recordEditorPerformanceDiagnostic(name, fullTextSnapshotDetail(length, retained))
}

function fullTextSnapshotDetail(
  length: number,
  retained: boolean,
): Readonly<Record<string, unknown>> {
  return {
    length,
    cached: retained,
    retained,
  }
}
