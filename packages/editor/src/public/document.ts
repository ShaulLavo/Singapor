export {
  Anchor,
  anchorAfter,
  anchorAt,
  anchorBefore,
  applyBatchToPieceTable,
  createPieceTableSnapshot,
  deleteFromPieceTable,
  forEachPieceTableTextChunk,
  getPieceTableLength,
  getPieceTableText,
  insertIntoPieceTable,
  offsetToPoint,
  pieceTableSnapshotsHaveSameText,
  pointToOffset,
  resolveAnchor,
} from '../pieceTable'
export { createDocumentSession, createStaticDocumentSession } from '../documentSession'
export { createDocumentTextSnapshot, createStringTextSnapshot } from '../documentTextSnapshot'
export type {
  AnchorBias,
  AnchorLiveness,
  PieceTableAnchor,
  PieceTableEdit,
  PieceTableSnapshot,
  Point,
  ResolvedAnchor,
} from '../pieceTable'
export type {
  DocumentSession,
  DocumentSessionApplyEditsOptions,
  DocumentSessionChange,
  DocumentSessionChangeKind,
  DocumentSessionEditHistoryMode,
  DocumentSessionEditSelection,
  DocumentSessionSelectionOptions,
  DocumentSessionSelectionRange,
  EditorTimingMeasurement,
} from '../documentSession'
export type { DocumentTextSnapshot, TextSnapshot } from '../documentTextSnapshot'
export type { EditorDocument, TextEdit } from '../tokens'
