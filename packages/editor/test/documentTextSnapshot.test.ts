import { afterEach, describe, expect, it } from 'vitest'
import { createDocumentTextSnapshot, createPieceTableSnapshot } from '../src/public/document'

type Diagnostic = {
  readonly name: string
  readonly detail?: Readonly<Record<string, unknown>>
}

type DiagnosticGlobal = typeof globalThis & {
  __EDITOR_PERFORMANCE_DIAGNOSTICS__?: ((diagnostic: Diagnostic) => void) | null
}

const diagnosticGlobal = (): DiagnosticGlobal => globalThis as DiagnosticGlobal

describe('DocumentTextSnapshot', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__EDITOR_PERFORMANCE_DIAGNOSTICS__')
  })

  it('does not retain computed full text reads', () => {
    const diagnostics = collectDiagnostics()
    const snapshot = createDocumentTextSnapshot(createPieceTableSnapshot('alpha'))

    expect(snapshot.getText()).toBe('alpha')
    expect(snapshot.getText()).toBe('alpha')

    const reads = diagnostics.filter((diagnostic) => diagnostic.name === 'textSnapshot.getText')
    expect(reads).toHaveLength(2)
    expect(reads.map((diagnostic) => diagnostic.detail)).toEqual([
      { length: 5, cached: false, retained: false },
      { length: 5, cached: false, retained: false },
    ])
  })

  it('keeps constructor-provided full text as the retained cache', () => {
    const diagnostics = collectDiagnostics()
    const snapshot = createDocumentTextSnapshot(createPieceTableSnapshot('alpha'), 'alpha')

    expect(snapshot.getText()).toBe('alpha')
    expect(snapshot.getText()).toBe('alpha')

    const reads = diagnostics.filter((diagnostic) => diagnostic.name === 'textSnapshot.getText')
    expect(reads).toHaveLength(2)
    expect(reads.map((diagnostic) => diagnostic.detail)).toEqual([
      { length: 5, cached: true, retained: true },
      { length: 5, cached: true, retained: true },
    ])
  })
})

function collectDiagnostics(): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  diagnosticGlobal().__EDITOR_PERFORMANCE_DIAGNOSTICS__ = (diagnostic) => {
    diagnostics.push(diagnostic)
  }
  return diagnostics
}
