import { performance } from 'node:perf_hooks'

import { resolveMinimapOptions } from '../src/options'
import { MinimapWorkerRenderer } from '../src/renderer'
import type { MinimapBaseStyles, MinimapDocumentPayload } from '../src/types'

type Sample = {
  readonly lines: number
  readonly textLength: number
  readonly iterations: number
  readonly averageEditMs: number
  readonly p95EditMs: number
  readonly worstEditMs: number
}

const LINE_COUNT = 100_000
const ITERATIONS = 50
const INSERTED_TEXT = '// MARK: minimap update\n'

const formatMs = (value: number): string => `${value.toFixed(4)}ms`

function createRenderer(): MinimapWorkerRenderer {
  const renderer = new MinimapWorkerRenderer()
  const canvas = { getContext: () => ({}) } as unknown as OffscreenCanvas
  renderer.init({
    mainCanvas: canvas,
    decorationsCanvas: canvas,
    options: resolveMinimapOptions(),
    styles: baseStyles(),
  })
  return renderer
}

function baseStyles(): MinimapBaseStyles {
  return {
    background: { r: 0, g: 0, b: 0, a: 255 },
    foreground: { r: 255, g: 255, b: 255, a: 255 },
    foregroundOpacity: 1,
    selection: { r: 10, g: 20, b: 30, a: 255 },
    minimapBackground: { r: 0, g: 0, b: 0, a: 255 },
    slider: 'rgba(255, 255, 255, 0.2)',
    sliderHover: 'rgba(255, 255, 255, 0.3)',
    sliderActive: 'rgba(255, 255, 255, 0.4)',
    fontFamily: 'monospace',
  }
}

function buildText(lines: number): string {
  const chunks: string[] = []

  for (let line = 0; line < lines; line += 1) {
    chunks.push(`const value${line} = ${line};\n`)
  }

  return chunks.join('')
}

function lineStarts(text: string): number[] {
  const starts = [0]

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    starts.push(index + 1)
  }

  return starts
}

function rendererDocument(renderer: MinimapWorkerRenderer): MinimapDocumentPayload {
  const state = (renderer as unknown as { state: { document: MinimapDocumentPayload } | null })
    .state
  if (!state) throw new Error('Expected initialized renderer')
  return state.document
}

function measure(): Sample {
  const renderer = createRenderer()
  const text = buildText(LINE_COUNT)
  renderer.setDocument({
    text,
    lineStarts: lineStarts(text),
    tokens: [],
    selections: [],
    decorations: [],
  })

  const durations = measureEdits(renderer)
  const document = rendererDocument(renderer)
  renderer.dispose()

  return {
    lines: LINE_COUNT,
    textLength: document.text.length,
    iterations: ITERATIONS,
    averageEditMs: average(durations),
    p95EditMs: percentile(durations, 0.95),
    worstEditMs: Math.max(...durations),
  }
}

function measureEdits(renderer: MinimapWorkerRenderer): number[] {
  const durations: number[] = []

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const offset = Math.floor(rendererDocument(renderer).text.length / 2)
    const start = performance.now()
    renderer.applyEdit({ from: offset, to: offset, text: INSERTED_TEXT }, { selections: [] })
    durations.push(performance.now() - start)
  }

  return durations
}

function average(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = values.toSorted((left, right) => left - right)
  const index = Math.ceil(sorted.length * percentileValue) - 1
  return sorted[Math.max(0, index)] ?? 0
}

function printSample(sample: Sample): void {
  console.log('minimap update benchmark')
  console.log(`lines: ${sample.lines.toLocaleString()}`)
  console.log(`final text length: ${sample.textLength.toLocaleString()}`)
  console.log(`iterations: ${sample.iterations}`)
  console.log(`average edit update: ${formatMs(sample.averageEditMs)}`)
  console.log(`p95 edit update: ${formatMs(sample.p95EditMs)}`)
  console.log(`worst edit update: ${formatMs(sample.worstEditMs)}`)
}

printSample(measure())
