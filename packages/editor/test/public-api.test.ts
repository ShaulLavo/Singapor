import { describe, expect, it } from 'vitest'

import {
  createMergeConflictDocumentText,
  createPieceTableSnapshot,
  Editor,
  getPieceTableText,
  parseMergeConflicts,
  type EditorState,
  type MergeConflictRegion,
  type TextEdit,
} from '../src/index.ts'

describe('public API facade', () => {
  it('exports editor and piece-table entrypoints from the package root', () => {
    const snapshot = createPieceTableSnapshot('abc')
    const edit: TextEdit = { from: 1, to: 2, text: 'B' }
    const state = { documentId: null } as EditorState

    expect(Editor).toBeTypeOf('function')
    expect(
      createMergeConflictDocumentText({
        localPath: 'file.ts',
        localText: 'abc',
        remotePath: 'file.ts',
        remoteText: 'abc',
      }),
    ).toBe('abc')
    expect(parseMergeConflicts('')).toEqual([])
    expect(getPieceTableText(snapshot)).toBe('abc')
    expect(edit).toEqual({ from: 1, to: 2, text: 'B' })
    expect({ index: 0 } as MergeConflictRegion).toMatchObject({ index: 0 })
    expect(state.documentId).toBeNull()
  })
})
