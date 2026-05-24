import { applyEditorTheme, type EditorTheme } from '@editor/core'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'

type MarkdownNode = {
  readonly type: string
  readonly value?: unknown
  readonly children?: readonly MarkdownNode[]
  readonly lang?: unknown
  readonly url?: unknown
  readonly ordered?: unknown
  readonly checked?: unknown
  readonly depth?: unknown
  readonly align?: readonly (string | null | undefined)[]
}

export type TooltipMarkdownRenderOptions = {
  readonly codeBackground?: boolean
}

const TYPESCRIPT_LIKE_LANGUAGES = new Set(['javascript', 'js', 'jsx', 'ts', 'tsx', 'typescript'])
const INLINE_CODE_BACKGROUND_VARIABLE = '--editor-typescript-lsp-hover-inline-code-background'
const CODE_BLOCK_BACKGROUND_VARIABLE = '--editor-typescript-lsp-hover-code-block-background'

const TYPESCRIPT_KEYWORDS = new Set([
  'abstract',
  'any',
  'as',
  'async',
  'await',
  'bigint',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'module',
  'namespace',
  'never',
  'new',
  'null',
  'number',
  'object',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'set',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unknown',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

const TYPESCRIPT_TOKEN_PATTERN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|[{}()[\].,;:?<>!=+\-*/%&|^~]+/g

const parseProcessor = unified().use(remarkParse).use(remarkGfm)
const stringifyProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify)

export function normalizeTooltipMarkdown(markdown: string): string {
  return String(stringifyProcessor.processSync(markdown))
}

export function renderTooltipMarkdown(
  document: Document,
  markdown: string,
  theme?: EditorTheme | null,
  options: TooltipMarkdownRenderOptions = {},
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'editor-typescript-lsp-hover-markdown'
  applyEditorTheme(root, theme)
  applyCodeBackgroundVariables(root, options)
  applyStyles(root, {
    display: 'block',
  })

  const tree = parseProcessor.parse(markdown) as MarkdownNode
  appendChildren(root, document, tree.children ?? [])
  return root
}

function appendChildren(parent: Node, document: Document, children: readonly MarkdownNode[]): void {
  for (const child of children) appendNode(parent, document, child)
}

function appendNode(parent: Node, document: Document, node: MarkdownNode): void {
  const rendered = renderNode(document, node)
  if (rendered) {
    parent.appendChild(rendered)
    return
  }

  appendChildren(parent, document, node.children ?? [])
}

function renderNode(document: Document, node: MarkdownNode): Node | null {
  if (node.type === 'text') return document.createTextNode(stringValue(node.value))
  if (node.type === 'paragraph') return parentElement(document, 'p', node)
  if (node.type === 'inlineCode') return inlineCodeElement(document, stringValue(node.value))
  if (node.type === 'code') return codeBlockElement(document, stringValue(node.value), node.lang)
  if (node.type === 'break') return document.createElement('br')
  if (node.type === 'emphasis') return parentElement(document, 'em', node)
  if (node.type === 'strong') return parentElement(document, 'strong', node)
  if (node.type === 'delete') return parentElement(document, 'del', node)
  if (node.type === 'link') return linkElement(document, node)
  if (node.type === 'list') return listElement(document, node)
  if (node.type === 'listItem') return listItemElement(document, node)
  if (node.type === 'table') return tableElement(document, node)
  if (node.type === 'heading') return headingElement(document, node)
  if (node.type === 'blockquote') return blockquoteElement(document, node)
  if (node.type === 'thematicBreak') return document.createElement('hr')
  if (node.type === 'html') return document.createTextNode(stringValue(node.value))
  return fallbackNode(document, node)
}

function parentElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
  node: MarkdownNode,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName)
  appendChildren(element, document, node.children ?? [])
  return element
}

function inlineCodeElement(document: Document, value: string): HTMLElement {
  const element = document.createElement('code')
  element.textContent = value
  applyStyles(element, {
    padding: '1px 4px',
    borderRadius: '4px',
    background: `var(${INLINE_CODE_BACKGROUND_VARIABLE}, transparent)`,
    color: 'var(--editor-foreground, #f4f4f5)',
    font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  })
  return element
}

function codeBlockElement(document: Document, value: string, lang: unknown): HTMLElement {
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  const language = typeof lang === 'string' ? lang.toLowerCase() : ''
  renderCodeContent(document, code, value, language)
  if (language) code.dataset.language = language

  applyStyles(pre, {
    margin: '0',
    padding: '0',
    borderRadius: '5px',
    background: `var(${CODE_BLOCK_BACKGROUND_VARIABLE}, transparent)`,
    color: 'var(--editor-foreground, #f4f4f5)',
    boxSizing: 'border-box',
    maxWidth: '100%',
    overflow: 'hidden',
  })
  applyStyles(code, {
    display: 'block',
    font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  })

  pre.append(code)
  return pre
}

function applyCodeBackgroundVariables(
  element: HTMLElement,
  options: TooltipMarkdownRenderOptions,
): void {
  if (!options.codeBackground) return

  element.style.setProperty(
    INLINE_CODE_BACKGROUND_VARIABLE,
    'color-mix(in srgb, var(--editor-foreground, #a1a1aa) 16%, transparent)',
  )
  element.style.setProperty(
    CODE_BLOCK_BACKGROUND_VARIABLE,
    'color-mix(in srgb, var(--editor-background, #09090b) 88%, var(--editor-foreground, #f4f4f5) 12%)',
  )
}

function renderCodeContent(
  document: Document,
  code: HTMLElement,
  value: string,
  language: string,
): void {
  if (!TYPESCRIPT_LIKE_LANGUAGES.has(language)) {
    code.textContent = value
    return
  }

  appendHighlightedTypeScript(document, code, value)
}

function appendHighlightedTypeScript(document: Document, code: HTMLElement, value: string): void {
  let cursor = 0
  for (const match of value.matchAll(TYPESCRIPT_TOKEN_PATTERN)) {
    const token = match[0]
    const index = match.index ?? cursor
    if (index > cursor) code.append(document.createTextNode(value.slice(cursor, index)))
    code.append(typeScriptTokenElement(document, token))
    cursor = index + token.length
  }
  if (cursor < value.length) code.append(document.createTextNode(value.slice(cursor)))
}

function typeScriptTokenElement(document: Document, token: string): HTMLElement {
  const element = document.createElement('span')
  element.textContent = token
  const tokenKind = typeScriptTokenKind(token)
  if (!tokenKind) return element

  element.className = `editor-typescript-lsp-hover-token-${tokenKind}`
  applyStyles(element, { color: typeScriptTokenColor(tokenKind) })
  return element
}

function typeScriptTokenKind(token: string): string | null {
  if (token.startsWith('//') || token.startsWith('/*')) return 'comment'
  if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) return 'string'
  if (/^(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)$/.test(token)) return 'number'
  if (TYPESCRIPT_KEYWORDS.has(token)) return 'keyword'
  if (/^[A-Z][\w$]*$/.test(token)) return 'type'
  if (/^[{}()[\].,;:?<>!=+\-*/%&|^~]+$/.test(token)) return 'punctuation'
  return null
}

function typeScriptTokenColor(tokenKind: string): string {
  if (tokenKind === 'comment') return 'var(--editor-syntax-comment, #a1a1aa)'
  if (tokenKind === 'string') return 'var(--editor-syntax-string, #86efac)'
  if (tokenKind === 'number') return 'var(--editor-syntax-number, #fbbf24)'
  if (tokenKind === 'keyword') return 'var(--editor-syntax-keyword, #93c5fd)'
  if (tokenKind === 'type') return 'var(--editor-syntax-type, #67e8f9)'
  return 'var(--editor-syntax-bracket, #d4d4d8)'
}

function linkElement(document: Document, node: MarkdownNode): HTMLElement {
  const href = safeLinkHref(node.url)
  if (!href) return parentElement(document, 'span', node)

  const element = document.createElement('a')
  element.href = href
  element.target = '_blank'
  element.rel = 'noreferrer'
  applyStyles(element, {
    color: 'var(--editor-caret-color, #93c5fd)',
    textDecoration: 'underline',
  })
  appendChildren(element, document, node.children ?? [])
  return element
}

function listElement(document: Document, node: MarkdownNode): HTMLElement {
  const element = document.createElement(node.ordered === true ? 'ol' : 'ul')
  applyStyles(element, {
    margin: '0',
    paddingLeft: '18px',
  })
  appendChildren(element, document, node.children ?? [])
  return element
}

function listItemElement(document: Document, node: MarkdownNode): HTMLElement {
  const element = document.createElement('li')
  if (typeof node.checked === 'boolean') element.append(taskCheckbox(document, node.checked))
  appendChildren(element, document, node.children ?? [])
  return element
}

function taskCheckbox(document: Document, checked: boolean): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  input.disabled = true
  input.tabIndex = -1
  applyStyles(input, {
    margin: '0 6px 0 0',
    verticalAlign: '-1px',
  })
  return input
}

function tableElement(document: Document, node: MarkdownNode): HTMLElement {
  const table = document.createElement('table')
  const rows = node.children ?? []
  applyStyles(table, {
    borderCollapse: 'collapse',
    fontSize: '12px',
  })
  appendTableHead(table, document, rows[0] ?? null, node.align ?? [])
  appendTableBody(table, document, rows.slice(1), node.align ?? [])
  return table
}

function appendTableHead(
  table: HTMLTableElement,
  document: Document,
  row: MarkdownNode | null,
  align: readonly (string | null | undefined)[],
): void {
  if (!row) return

  const head = document.createElement('thead')
  head.append(tableRowElement(document, row, 'th', align))
  table.append(head)
}

function appendTableBody(
  table: HTMLTableElement,
  document: Document,
  rows: readonly MarkdownNode[],
  align: readonly (string | null | undefined)[],
): void {
  if (rows.length === 0) return

  const body = document.createElement('tbody')
  for (const row of rows) body.append(tableRowElement(document, row, 'td', align))
  table.append(body)
}

function tableRowElement(
  document: Document,
  row: MarkdownNode,
  cellTagName: 'td' | 'th',
  align: readonly (string | null | undefined)[],
): HTMLTableRowElement {
  const element = document.createElement('tr')
  const cells = row.children ?? []
  for (let index = 0; index < cells.length; index += 1) {
    element.append(tableCellElement(document, cells[index]!, cellTagName, align[index]))
  }
  return element
}

function tableCellElement(
  document: Document,
  node: MarkdownNode,
  tagName: 'td' | 'th',
  align: string | null | undefined,
): HTMLTableCellElement {
  const element = document.createElement(tagName)
  applyStyles(element, {
    padding: '3px 7px',
    border: '1px solid color-mix(in srgb, var(--editor-foreground, #a1a1aa) 22%, transparent)',
    textAlign: tableTextAlign(align),
  })
  appendChildren(element, document, node.children ?? [])
  return element
}

function headingElement(document: Document, node: MarkdownNode): HTMLElement {
  const element = parentElement(document, 'div', node)
  element.setAttribute('role', 'heading')
  element.setAttribute('aria-level', String(headingDepth(node.depth)))
  applyStyles(element, {
    fontWeight: '650',
  })
  return element
}

function blockquoteElement(document: Document, node: MarkdownNode): HTMLElement {
  const element = parentElement(document, 'blockquote', node)
  applyStyles(element, {
    margin: '0',
    paddingLeft: '10px',
    borderLeft: '2px solid color-mix(in srgb, var(--editor-foreground, #a1a1aa) 46%, transparent)',
    color: 'color-mix(in srgb, var(--editor-foreground, #d4d4d8) 86%, transparent)',
  })
  return element
}

function fallbackNode(document: Document, node: MarkdownNode): Node | null {
  if (typeof node.value === 'string') return document.createTextNode(node.value)
  if (!node.children || node.children.length === 0) return null

  const element = document.createElement('span')
  appendChildren(element, document, node.children)
  return element
}

function safeLinkHref(url: unknown): string | null {
  if (typeof url !== 'string') return null

  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href
    if (parsed.protocol === 'mailto:') return parsed.href
    return null
  } catch {
    return null
  }
}

function tableTextAlign(align: string | null | undefined): string {
  if (align === 'left' || align === 'right' || align === 'center') return align
  return 'left'
}

function headingDepth(depth: unknown): number {
  if (typeof depth !== 'number') return 2
  return Math.min(6, Math.max(1, Math.trunc(depth)))
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function applyStyles(element: HTMLElement, styles: Readonly<Record<string, string>>): void {
  for (const [property, value] of Object.entries(styles)) {
    element.style.setProperty(cssPropertyName(property), value)
  }
}

function cssPropertyName(property: string): string {
  return property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
}
