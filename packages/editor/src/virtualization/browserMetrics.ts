export type BrowserTextMetrics = {
  readonly rowHeight: number
  readonly characterWidth: number
}

const DEFAULT_ROW_HEIGHT = 24
const DEFAULT_CHARACTER_WIDTH = 8
const PROBE_TEXT = 'mmmmmmmmmmmmmmmm'
let metricsCache = new WeakMap<Document, Map<string, BrowserTextMetrics>>()

export function measureBrowserTextMetrics(element: HTMLElement): BrowserTextMetrics {
  const cacheKey = browserTextMetricsCacheKey(element)
  const cached = cacheKey ? cachedBrowserTextMetrics(element.ownerDocument, cacheKey) : null
  if (cached) return cached

  const document = element.ownerDocument
  const probe = document.createElement('span')
  probe.className = 'editor-virtualized-metric-probe'
  probe.textContent = PROBE_TEXT
  element.appendChild(probe)

  const rect = probe.getBoundingClientRect()
  const style = readComputedStyle(probe)
  const rowHeight = measuredRowHeight(rect, style)
  const characterWidth = measuredCharacterWidth(rect)
  probe.remove()

  const metrics = { rowHeight, characterWidth }
  if (cacheKey) cacheBrowserTextMetrics(document, cacheKey, metrics)
  return metrics
}

export function clearBrowserTextMetricsCache(): void {
  metricsCache = new WeakMap<Document, Map<string, BrowserTextMetrics>>()
}

function measuredRowHeight(rect: DOMRect, style: CSSStyleDeclaration | undefined): number {
  const lineHeight = cssPixels(style, 'lineHeight')
  if (lineHeight !== null && lineHeight > 0) return lineHeight
  if (Number.isFinite(rect.height) && rect.height > 0) return rect.height

  const fontSize = cssPixels(style, 'fontSize')
  if (fontSize !== null && fontSize > 0) return Math.ceil(fontSize * 1.5)
  return DEFAULT_ROW_HEIGHT
}

function measuredCharacterWidth(rect: DOMRect): number {
  if (!Number.isFinite(rect.width) || rect.width <= 0) return DEFAULT_CHARACTER_WIDTH
  return Math.max(1, rect.width / PROBE_TEXT.length)
}

function readComputedStyle(element: HTMLElement): CSSStyleDeclaration | undefined {
  try {
    return element.ownerDocument.defaultView?.getComputedStyle(element)
  } catch {
    return undefined
  }
}

function cssPixels(
  style: CSSStyleDeclaration | undefined,
  property: 'fontSize' | 'lineHeight',
): number | null {
  try {
    return parseCssPixels(style?.[property])
  } catch {
    return null
  }
}

function parseCssPixels(value: string | undefined): number | null {
  if (!value || value === 'normal') return null

  const pixels = Number.parseFloat(value)
  if (!Number.isFinite(pixels)) return null
  return pixels
}

function cachedBrowserTextMetrics(document: Document, key: string): BrowserTextMetrics | null {
  return metricsCache.get(document)?.get(key) ?? null
}

function cacheBrowserTextMetrics(
  document: Document,
  key: string,
  metrics: BrowserTextMetrics,
): void {
  const cache = metricsCache.get(document) ?? new Map<string, BrowserTextMetrics>()
  cache.set(key, metrics)
  metricsCache.set(document, cache)
}

function browserTextMetricsCacheKey(element: HTMLElement): string | null {
  const style = readComputedStyle(element)
  if (!style) return null

  return [
    style.fontFamily,
    style.fontSize,
    style.fontStyle,
    style.fontStretch,
    style.fontVariant,
    style.fontWeight,
    style.letterSpacing,
    style.lineHeight,
    style.textTransform,
    style.whiteSpace,
  ].join('\n')
}
