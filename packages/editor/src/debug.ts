/**
 * Debug-only entry point for implementation diagnostics.
 *
 * @deprecated Phase 1 containment keeps piece-table inspection out of the public facade. Replace
 * package implementation imports before Phase 2 document-truth work removes this compatibility path.
 */
export { debugPieceTable } from './pieceTable'
export type { PieceBufferId, PieceTableSnapshot } from './pieceTable'
