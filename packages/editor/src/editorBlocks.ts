import type { EditorDisposable } from './plugins'

export type EditorBlock = {
  readonly id: string
  readonly anchor: EditorBlockAnchor
  readonly top?: EditorBlockHorizontalSurface
  readonly bottom?: EditorBlockHorizontalSurface
  readonly left?: EditorBlockVerticalSurface
  readonly right?: EditorBlockVerticalSurface
}

export type EditorBlockAnchor =
  | {
      readonly row: number
    }
  | {
      readonly startRow: number
      readonly endRow: number
    }

export type FixedSize = {
  readonly px: number
  readonly minPx?: never
  readonly maxPx?: never
}

export type MinSize = {
  readonly px?: never
  readonly minPx: number
  readonly maxPx?: never
}

export type MaxSize = {
  readonly px?: never
  readonly minPx?: never
  readonly maxPx: number
}

export type BoundedSize = {
  readonly px?: never
  readonly minPx: number
  readonly maxPx: number
}

export type EditorBlockSize = FixedSize | MinSize | MaxSize | BoundedSize

export type EditorBlockHorizontalSurface = {
  readonly height: EditorBlockSize
  readonly width?: never
  readonly mount: EditorBlockMount
}

export type EditorBlockVerticalSurface = {
  readonly width: EditorBlockSize
  readonly height?: never
  readonly mount: EditorBlockMount
}

export type EditorBlockMount = (
  container: HTMLElement,
  context: EditorBlockMountContext,
) => void | EditorDisposable

export type EditorBlockMountContext = {
  readonly blockId: string
  readonly surface: EditorBlockSurfaceSlot
  readonly anchor: EditorBlockAnchor
  readonly documentId: string | null
  readonly text: string
  focusEditor(): void
  setSelection(anchor: number, head: number): void
  requestMeasure(): void
}

export type EditorBlockSurfaceSlot = 'top' | 'bottom' | 'left' | 'right'

export type EditorBlockProvider = {
  getBlocks(context: EditorBlockProviderContext): readonly EditorBlock[]
  onDidChangeBlocks?(listener: () => void): EditorDisposable
}

export type EditorBlockProviderContext = {
  readonly documentId: string | null
  readonly text: string
  readonly lineCount: number
}
