import { describe, expect, it } from 'vitest'

import { createEditorPane } from '../../src/components/editorPane.ts'

describe('createEditorPane', () => {
  it('creates editor and diff hosts', () => {
    const pane = createEditorPane()

    expect(pane.element).toBeInstanceOf(HTMLDivElement)
    expect(pane.element.id).toBe('editor-container')
    expect(pane.editorHost.id).toBe('editor-host')
    expect(pane.diffHost.id).toBe('diff-host')
    expect(pane.diffHost.hidden).toBe(true)
  })
})
