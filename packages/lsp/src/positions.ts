import type * as lsp from "vscode-languageserver-protocol";
import type { LspTextEdit } from "./types";

export type LspContentChangeOptions = {
  readonly incremental?: boolean;
  readonly edits?: readonly LspTextEdit[];
};

export function offsetToLspPosition(text: string, offset: number): lsp.Position {
  if (offset < 0 || offset > text.length) throw new RangeError("invalid offset");

  return positionForOffset(text, offset);
}

export function lspPositionToOffset(text: string, position: lsp.Position): number {
  const lineStart = lineStartForLspLine(text, nonNegativeInteger(position.line));
  return offsetInLine(text, lineStart, nonNegativeInteger(position.character));
}

export const textEditToLspContentChange = (
  previousText: string,
  edit: LspTextEdit,
): lsp.TextDocumentContentChangeEvent => {
  validateTextEdit(previousText, edit);
  return {
    range: lspRangeForTextEdit(previousText, edit),
    text: edit.text,
  };
};

export const textEditsToLspContentChanges = (
  previousText: string,
  edits: readonly LspTextEdit[],
): readonly lsp.TextDocumentContentChangeEvent[] => {
  if (edits.length === 0) return [];
  if (!areValidBatchEdits(previousText, edits)) return [];

  const changes: lsp.TextDocumentContentChangeEvent[] = [];

  for (const edit of edits.toSorted(compareTextEditsDescending)) {
    changes.push({
      range: lspRangeForTextEdit(previousText, edit),
      text: edit.text,
    });
  }

  return changes;
};

export const createLspContentChanges = (
  previousText: string,
  nextText: string,
  options: LspContentChangeOptions = {},
): readonly lsp.TextDocumentContentChangeEvent[] => {
  if (!options.incremental) return [createFullContentChange(nextText)];
  if (!options.edits || options.edits.length === 0) return [createFullContentChange(nextText)];

  const changes = textEditsToLspContentChanges(previousText, options.edits);
  const editedText = applyTextEdits(previousText, options.edits);
  if (changes.length === 0 || editedText !== nextText) return [createFullContentChange(nextText)];

  return changes;
};

const LF = 10;
const CR = 13;

function positionForOffset(text: string, offset: number): lsp.Position {
  let index = 0;
  let line = 0;
  let lineStart = 0;

  while (index < offset) {
    const code = text.charCodeAt(index);
    if (!(code === LF || code === CR)) {
      index += 1;
      continue;
    }

    const breakEnd = lineBreakEnd(text, index, code);
    if (offset < breakEnd) return { line, character: index - lineStart };

    index = breakEnd;
    lineStart = breakEnd;
    line += 1;
  }

  return { line, character: offset - lineStart };
}

function lspRangeForTextEdit(text: string, edit: LspTextEdit): lsp.Range {
  let index = 0;
  let line = 0;
  let lineStart = 0;

  function readPosition(offset: number): lsp.Position {
    while (index < offset) {
      const code = text.charCodeAt(index);
      if (!(code === LF || code === CR)) {
        index += 1;
        continue;
      }

      const breakEnd = lineBreakEnd(text, index, code);
      if (offset < breakEnd) return { line, character: index - lineStart };

      index = breakEnd;
      lineStart = breakEnd;
      line += 1;
    }

    return { line, character: offset - lineStart };
  }

  return {
    start: readPosition(edit.from),
    end: readPosition(edit.to),
  };
}

function lineStartForLspLine(text: string, targetLine: number): number {
  let index = 0;
  let line = 0;
  let lineStart = 0;

  while (line < targetLine && index < text.length) {
    const code = text.charCodeAt(index);
    if (!(code === LF || code === CR)) {
      index += 1;
      continue;
    }

    lineStart = lineBreakEnd(text, index, code);
    index = lineStart;
    line += 1;
  }

  return lineStart;
}

function offsetInLine(text: string, lineStart: number, character: number): number {
  const requestedOffset = lineStart + character;
  let index = lineStart;

  while (index < requestedOffset && index < text.length) {
    const code = text.charCodeAt(index);
    if (code === LF || code === CR) return index;
    index += 1;
  }

  return Math.min(requestedOffset, text.length);
}

function lineBreakEnd(text: string, index: number, code: number): number {
  if (code !== CR) return index + 1;
  if (text.charCodeAt(index + 1) === LF) return index + 2;
  return index + 1;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

const createFullContentChange = (text: string): lsp.TextDocumentContentChangeEvent => ({ text });

const applyTextEdits = (text: string, edits: readonly LspTextEdit[]): string | null => {
  if (!areValidBatchEdits(text, edits)) return null;

  let nextText = text;
  for (const edit of edits.toSorted(compareTextEditsDescending)) {
    nextText = applyTextEdit(nextText, edit);
  }

  return nextText;
};

const applyTextEdit = (text: string, edit: LspTextEdit): string =>
  `${text.slice(0, edit.from)}${edit.text}${text.slice(edit.to)}`;

const areValidBatchEdits = (text: string, edits: readonly LspTextEdit[]): boolean => {
  let previousEnd = -1;
  for (const edit of edits.toSorted(compareTextEditsAscending)) {
    if (!isValidTextEdit(text, edit)) return false;
    if (edit.from < previousEnd) return false;
    previousEnd = edit.to;
  }

  return true;
};

const validateTextEdit = (text: string, edit: LspTextEdit): void => {
  if (isValidTextEdit(text, edit)) return;
  throw new RangeError("invalid text edit");
};

const isValidTextEdit = (text: string, edit: LspTextEdit): boolean =>
  edit.from >= 0 && edit.to >= edit.from && edit.to <= text.length;

const compareTextEditsAscending = (left: LspTextEdit, right: LspTextEdit): number =>
  left.from - right.from || left.to - right.to;

const compareTextEditsDescending = (left: LspTextEdit, right: LspTextEdit): number =>
  right.from - left.from || right.to - left.to;
