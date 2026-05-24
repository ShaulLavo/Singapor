/**
 * @deprecated Temporary Phase 1 bridge for workspace packages while internals are migrated behind
 * typed public contracts. Remove these exports in the phase that owns each subsystem.
 */
export {
  createAnchorSelection,
  createSelectionSet,
  normalizeSelectionSet,
  resolveSelection,
} from './selections'
export { defineLazyTextProperty } from './documentTextSnapshot'
export {
  documentSessionChangeTextSnapshot,
  withDocumentSessionChangeTimings,
} from './documentSession'
export { VirtualizedTextView } from './virtualization'
export type { AnchorSelection, SelectionSet } from './selections'
export type { PieceTableAnchor } from './pieceTable'
export type { VirtualizedTextViewState } from './virtualization'
