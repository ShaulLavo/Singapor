import { el } from './dom.ts'

export type EditorPane = {
  readonly element: HTMLDivElement
  readonly editorHost: HTMLDivElement
  readonly diffHost: HTMLDivElement
}

export function createEditorPane(): EditorPane {
  const element = el('div', { id: 'editor-container' })
  const editorHost = el('div', { id: 'editor-host' })
  const diffHost = el('div', { id: 'diff-host' })
  diffHost.hidden = true
  element.append(editorHost, diffHost)

  return {
    element,
    editorHost,
    diffHost,
  }
}
