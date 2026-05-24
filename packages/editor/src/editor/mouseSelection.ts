import { clamp } from '../style-utils'
import { nowMs } from './timing'

export type MouseSelectionDrag = {
  readonly anchorOffset: number
  headOffset: number
  clientX: number
  clientY: number
}

const MOUSE_SELECTION_SCROLL_ZONE_PX = 40
const MOUSE_SELECTION_MAX_SCROLL_PX = 24
const MOUSE_SELECTION_MIN_SCROLL_PX = 2

export function mouseSelectionAutoScrollDelta(clientY: number, rect: DOMRect): number {
  if (rect.height <= 0) return 0
  if (clientY < rect.top + MOUSE_SELECTION_SCROLL_ZONE_PX) {
    return -mouseSelectionScrollStep(rect.top + MOUSE_SELECTION_SCROLL_ZONE_PX - clientY)
  }
  if (clientY > rect.bottom - MOUSE_SELECTION_SCROLL_ZONE_PX) {
    return mouseSelectionScrollStep(clientY - (rect.bottom - MOUSE_SELECTION_SCROLL_ZONE_PX))
  }

  return 0
}

export function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return setTimeout(() => callback(nowMs()), 0) as unknown as number
}

export function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle)
    return
  }

  clearTimeout(handle)
}

function mouseSelectionScrollStep(distance: number): number {
  const ratio = distance / MOUSE_SELECTION_SCROLL_ZONE_PX
  const scaled = Math.ceil(ratio * MOUSE_SELECTION_MAX_SCROLL_PX)
  return clamp(scaled, MOUSE_SELECTION_MIN_SCROLL_PX, MOUSE_SELECTION_MAX_SCROLL_PX)
}
