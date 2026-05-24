import { describe, expect, it } from 'vitest'
import {
  createMergeConflictDocumentText,
  parseMergeConflicts,
  resolveMergeConflict,
} from '../src/editor'

describe('merge conflict document text', () => {
  it('wraps only a one-line replacement', () => {
    expect(
      createMergeConflictDocumentText({
        localPath: '/path/file.ts',
        localText: ['one', 'two', 'three', ''].join('\n'),
        remotePath: '/path/file.ts',
        remoteText: ['one', 'TWO', 'three', ''].join('\n'),
      }),
    ).toBe(
      [
        'one',
        '<<<<<<< Local: /path/file.ts',
        'two',
        '=======',
        'TWO',
        '>>>>>>> Remote: /path/file.ts',
        'three',
        '',
      ].join('\n'),
    )
  })

  it('creates an empty local side for remote insertions', () => {
    expect(
      createMergeConflictDocumentText({
        localPath: '/path/file.ts',
        localText: ['one', 'three', ''].join('\n'),
        remotePath: '/path/file.ts',
        remoteText: ['one', 'two', 'three', ''].join('\n'),
      }),
    ).toBe(
      [
        'one',
        '<<<<<<< Local: /path/file.ts',
        '=======',
        'two',
        '>>>>>>> Remote: /path/file.ts',
        'three',
        '',
      ].join('\n'),
    )
  })

  it('creates an empty remote side for remote line deletions', () => {
    expect(
      createMergeConflictDocumentText({
        localPath: '/path/file.ts',
        localText: ['one', 'two', 'three', ''].join('\n'),
        remotePath: '/path/file.ts',
        remoteText: ['one', 'three', ''].join('\n'),
      }),
    ).toBe(
      [
        'one',
        '<<<<<<< Local: /path/file.ts',
        'two',
        '=======',
        '>>>>>>> Remote: /path/file.ts',
        'three',
        '',
      ].join('\n'),
    )
  })

  it('creates a whole-file conflict for remote file deletion', () => {
    expect(
      createMergeConflictDocumentText({
        localPath: '/path/file.ts',
        localText: ['one', 'two', ''].join('\n'),
        remotePath: '/path/file.ts',
        remoteText: null,
      }),
    ).toBe(
      [
        '<<<<<<< Local: /path/file.ts',
        'one',
        'two',
        '=======',
        '>>>>>>> Remote: /path/file.ts',
        '',
      ].join('\n'),
    )
  })

  it('emits multiple independent conflict blocks', () => {
    const text = createMergeConflictDocumentText({
      localPath: '/path/file.ts',
      localText: ['one', 'two', 'three', 'four', 'five', ''].join('\n'),
      remotePath: '/path/file.ts',
      remoteText: ['ONE', 'two', 'three', 'FOUR', 'five', ''].join('\n'),
    })

    expect(parseMergeConflicts(text)).toHaveLength(2)
    expect(text).toBe(
      [
        '<<<<<<< Local: /path/file.ts',
        'one',
        '=======',
        'ONE',
        '>>>>>>> Remote: /path/file.ts',
        'two',
        'three',
        '<<<<<<< Local: /path/file.ts',
        'four',
        '=======',
        'FOUR',
        '>>>>>>> Remote: /path/file.ts',
        'five',
        '',
      ].join('\n'),
    )
  })

  it('returns unchanged local text when there is no diff', () => {
    const text = ['one', 'two', ''].join('\n')

    expect(
      createMergeConflictDocumentText({
        localPath: '/path/file.ts',
        localText: text,
        remotePath: '/path/file.ts',
        remoteText: text,
      }),
    ).toBe(text)
  })
})

describe('merge conflict parsing', () => {
  it('finds two-sided git conflict marker regions', () => {
    const text = [
      'before',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> branch',
      'after',
    ].join('\n')

    const conflicts = parseMergeConflicts(text)

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      index: 0,
      oursLabel: 'HEAD',
      theirsLabel: 'branch',
    })
    expect(slice(text, conflicts[0]!.ours)).toBe('ours\n')
    expect(slice(text, conflicts[0]!.theirs)).toBe('theirs\n')
  })

  it('finds diff3 conflicts with a base section', () => {
    const text = [
      '<<<<<<< ours',
      'ours',
      '||||||| base',
      'base',
      '=======',
      'theirs',
      '>>>>>>> theirs',
      '',
    ].join('\n')

    const conflict = parseMergeConflicts(text)[0]!

    expect(conflict.baseLabel).toBe('base')
    expect(slice(text, conflict.ours)).toBe('ours\n')
    expect(slice(text, conflict.base!)).toBe('base\n')
    expect(slice(text, conflict.theirs)).toBe('theirs\n')
  })

  it('ignores incomplete conflicts', () => {
    const text = ['<<<<<<< HEAD', 'ours', '=======', 'theirs'].join('\n')

    expect(parseMergeConflicts(text)).toEqual([])
  })
})

describe('merge conflict resolution', () => {
  it('resolves to ours, theirs, both, and base', () => {
    const text = [
      'start',
      '<<<<<<< ours',
      'ours',
      '||||||| base',
      'base',
      '=======',
      'theirs',
      '>>>>>>> theirs',
      'end',
    ].join('\n')
    const conflict = parseMergeConflicts(text)[0]!

    expect(resolveMergeConflict(text, conflict, 'ours')?.text).toBe('start\nours\nend')
    expect(resolveMergeConflict(text, conflict, 'theirs')?.text).toBe('start\ntheirs\nend')
    expect(resolveMergeConflict(text, conflict, 'both')?.text).toBe('start\nours\ntheirs\nend')
    expect(resolveMergeConflict(text, conflict, 'base')?.text).toBe('start\nbase\nend')
  })

  it('returns null when resolving to an absent base', () => {
    const text = ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> branch'].join('\n')
    const conflict = parseMergeConflicts(text)[0]!

    expect(resolveMergeConflict(text, conflict, 'base')).toBeNull()
  })

  it('honors explicit side ordering', () => {
    const text = ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> branch', ''].join('\n')
    const conflict = parseMergeConflicts(text)[0]!

    expect(resolveMergeConflict(text, conflict, ['theirs', 'ours'])?.text).toBe('theirs\nours\n')
  })
})

function slice(text: string, range: { readonly start: number; readonly end: number }): string {
  return text.slice(range.start, range.end)
}
