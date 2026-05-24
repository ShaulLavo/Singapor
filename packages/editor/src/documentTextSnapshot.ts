import type { PieceTableSnapshot } from './pieceTable/pieceTableTypes'
import { forEachPieceTableTextChunk, getPieceTableText } from './pieceTable/reads'
import {
  measureEditorPerformance,
  recordEditorPerformanceDiagnostic,
} from './editor/performanceDiagnostics'

export type TextSnapshot = {
  readonly length: number
  getText(): string
  getTextInRange(start: number, end?: number): string
  forEachTextChunk(visit: (text: string, start: number, end: number) => void): void
}

export type DocumentTextSnapshot = TextSnapshot & {
  readonly snapshot: PieceTableSnapshot
}

export function createDocumentTextSnapshot(
  snapshot: PieceTableSnapshot,
  materializedText?: string,
): DocumentTextSnapshot {
  const retainedText = materializedText?.length === snapshot.length ? materializedText : undefined

  return {
    snapshot,
    length: snapshot.length,
    getText: () => {
      if (retainedText !== undefined) {
        recordFullTextSnapshotRead('textSnapshot.getText', snapshot.length, true)
        return retainedText
      }

      return measureEditorPerformance(
        'textSnapshot.getText',
        () => getPieceTableText(snapshot),
        () => fullTextSnapshotDetail(snapshot.length, false),
      )
    },
    getTextInRange: (start, end) => {
      const effectiveEnd = end ?? snapshot.length
      if (retainedText !== undefined && start === 0 && effectiveEnd === snapshot.length) {
        recordFullTextSnapshotRead('textSnapshot.getTextInRange', snapshot.length, true)
        return retainedText
      }

      if (start === 0 && effectiveEnd === snapshot.length) {
        return measureEditorPerformance(
          'textSnapshot.getTextInRange',
          () => getPieceTableText(snapshot, start, effectiveEnd),
          () => fullTextSnapshotDetail(snapshot.length, false),
        )
      }

      return getPieceTableText(snapshot, start, effectiveEnd)
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
    getText: () => text,
    getTextInRange: (start, end) => text.slice(start, end),
    forEachTextChunk: (visit) => {
      if (text.length > 0) visit(text, 0, text.length)
    },
  }
}

export function defineLazyTextProperty<T extends { readonly textSnapshot: TextSnapshot }>(
  target: T,
): T & { readonly text: string } {
  Object.defineProperty(target, 'text', {
    configurable: true,
    enumerable: true,
    get: () => target.textSnapshot.getText(),
  })
  return target as T & { readonly text: string }
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
