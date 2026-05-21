import type { DocumentSession, DocumentSessionChange } from "../documentSession";
import { getPieceTableText } from "../pieceTable/reads";
import {
  SelectionGoal,
  resolveSelection,
  type ResolvedSelection,
  type SelectionGoal as SelectionGoalValue,
} from "../selections";
import { clamp } from "../style-utils";
import type { TextEdit } from "../tokens";
import type { VirtualizedTextView } from "../virtualization/virtualizedTextView";
import type {
  EditorResolvedSelection,
  EditorSelectionRange,
  EditorViewContributionUpdateKind,
} from "../plugins";
import type { EditorSyntaxLanguageId } from "../syntax/session";
import { childContainingNode, childNodeIndex, elementBoundaryToTextOffset } from "./domBoundary";
import { editActionForCommand, type EditorEditActionCommandId } from "./editActions";
import {
  capitalize,
  eventTargetInsideBlockSurface,
  indentTimingName,
  selectionGoalColumn,
  type SessionChangeOptions,
} from "./editorUtils";
import { keyboardFallbackText } from "./input";
import {
  cancelFrame,
  mouseSelectionAutoScrollDelta,
  requestFrame,
  type MouseSelectionDrag,
} from "./mouseSelection";
import { navigationTargetForCommand } from "./navigationTargets";
import {
  findAllExactOccurrences,
  findNextExactOccurrence,
  findNextExactOccurrenceFromRange,
  getOccurrenceQuery,
  occurrenceQueryForSelection,
  occurrenceSelectTimingName,
  type OccurrenceQuery,
  type OccurrenceSelectionChange,
} from "./occurrences";
import { lineRangeAtOffset, wordRangeAtOffset } from "./textRanges";
import { appendTiming, eventStartMs, mergeChangeTimings, nowMs } from "./timing";
import type { EditorCommandContext, EditorCommandId } from "./commands";
import type { EditorSelectionSyncMode, EditorSessionOptions } from "./types";

export type InputSelectionControllerOptions = {
  readonly el: HTMLDivElement;
  readonly selectionSyncMode: EditorSelectionSyncMode;
  readonly tabSize: number;
  readonly view: VirtualizedTextView;
  getLanguageId(): EditorSyntaxLanguageId | null;
  getSession(): DocumentSession | null;
  getSessionOptions(): EditorSessionOptions;
  getText(): string;
  canEditDocument(): boolean;
  applySessionChange(
    change: DocumentSessionChange,
    totalName?: string,
    totalStart?: number,
    options?: SessionChangeOptions,
  ): void;
  notifyChangeWithTiming(change: DocumentSessionChange): void;
  notifyViewContributions(
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void;
};

type PendingKeyboardTextFallback = {
  timerId: number;
  nativeInputGeneration: number;
  startMs: number;
  text: string;
};

type NativeTextInputState = "unknown" | "observed" | "missing";

type InputProbeExtra = Record<string, unknown>;

const INPUT_PROBE_GLOBAL_EVENT_TYPES = [
  "beforeinput",
  "input",
  "textInput",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "focusin",
  "focusout",
] as const;

function inputProbeElementLabel(target: EventTarget | null): string | null {
  if (!target) return null;
  if (!(target instanceof Element)) return inputProbeNodeLabel(target);

  const id = target.id ? `#${target.id}` : "";
  const className = typeof target.className === "string" ? target.className.trim() : "";
  const classes = className ? `.${className.replace(/\s+/g, ".")}` : "";
  return `${target.tagName}${id}${classes}`;
}

function inputProbeNodeLabel(target: EventTarget): string {
  if (target instanceof Node) return target.nodeName;
  return String(target);
}

function inputProbeEventState(event?: Event): InputProbeExtra {
  if (!event) return {};

  return {
    altKey: inputProbeModifier(event, "altKey"),
    ctrlKey: inputProbeModifier(event, "ctrlKey"),
    eventCancelable: event.cancelable,
    eventDefaultPrevented: event.defaultPrevented,
    eventIsTrusted: event.isTrusted,
    eventTarget: inputProbeElementLabel(event.target),
    eventTimeStamp: event.timeStamp,
    eventType: event.type,
    metaKey: inputProbeModifier(event, "metaKey"),
    inputData: inputProbeInputData(event),
    inputType: inputProbeInputType(event),
    key: inputProbeKey(event),
    code: inputProbeCode(event),
    isComposing: inputProbeIsComposing(event),
    repeat: inputProbeRepeat(event),
    shiftKey: inputProbeModifier(event, "shiftKey"),
    modifierState: inputProbeModifierState(event),
  };
}

function inputProbeModifier(
  event: Event,
  key: "altKey" | "ctrlKey" | "metaKey" | "shiftKey",
): boolean | null {
  if (!(key in event)) return null;
  const value = (event as Partial<Record<typeof key, unknown>>)[key];
  return typeof value === "boolean" ? value : null;
}

function inputProbeInputData(event: Event): string | null {
  if (!("data" in event)) return null;
  return typeof event.data === "string" ? event.data : null;
}

function inputProbeInputType(event: Event): string | null {
  if (!("inputType" in event)) return null;
  return typeof event.inputType === "string" ? event.inputType : null;
}

function inputProbeKey(event: Event): string | null {
  if (!("key" in event)) return null;
  return typeof event.key === "string" ? event.key : null;
}

function inputProbeCode(event: Event): string | null {
  if (!("code" in event)) return null;
  return typeof event.code === "string" ? event.code : null;
}

function inputProbeIsComposing(event: Event): boolean | null {
  if (!("isComposing" in event)) return null;
  return typeof event.isComposing === "boolean" ? event.isComposing : null;
}

function inputProbeRepeat(event: Event): boolean | null {
  if (!("repeat" in event)) return null;
  return typeof event.repeat === "boolean" ? event.repeat : null;
}

function inputProbeModifierState(event: Event): InputProbeExtra | null {
  if (!("getModifierState" in event)) return null;
  if (typeof event.getModifierState !== "function") return null;

  return {
    AltGraph: event.getModifierState("AltGraph"),
    CapsLock: event.getModifierState("CapsLock"),
    Fn: event.getModifierState("Fn"),
    NumLock: event.getModifierState("NumLock"),
    Symbol: event.getModifierState("Symbol"),
  };
}

function inputProbeRect(rect: DOMRect): InputProbeExtra {
  return {
    bottom: Math.round(rect.bottom),
    height: Math.round(rect.height),
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
  };
}

function inputProbeMatches(element: Element, selector: string): boolean | null {
  try {
    return element.matches(selector);
  } catch {
    return null;
  }
}

function inputProbeStringify(payload: InputProbeExtra): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (!value || typeof value !== "object") return value;

    const timerLabel = inputProbeTimerObjectLabel(value);
    if (timerLabel) return timerLabel;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value;
  });
}

function inputProbeTimerObjectLabel(value: object): string | null {
  if (value.constructor?.name !== "Timeout") return null;
  return "[Timeout]";
}

function inputProbeSelectionState(document: Document): InputProbeExtra | null {
  const selection = document.getSelection();
  if (!selection) return null;

  return {
    anchorNode: inputProbeElementLabel(selection.anchorNode),
    anchorOffset: selection.anchorOffset,
    focusNode: inputProbeElementLabel(selection.focusNode),
    focusOffset: selection.focusOffset,
    isCollapsed: selection.isCollapsed,
    rangeCount: selection.rangeCount,
    type: selection.type,
  };
}

function inputProbeAncestorChain(
  element: HTMLElement,
  root: HTMLElement,
): readonly InputProbeExtra[] {
  const chain: InputProbeExtra[] = [];
  let current: HTMLElement | null = element;
  while (current && chain.length < 32) {
    chain.push(inputProbeAncestorEntry(current, root));
    if (current === current.ownerDocument.documentElement) break;
    current = current.parentElement;
  }
  return chain;
}

function inputProbeAncestorEntry(element: HTMLElement, root: HTMLElement): InputProbeExtra {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return {
    label: inputProbeElementLabel(element),
    ariaHidden: element.getAttribute("aria-hidden"),
    contentEditable: element.contentEditable,
    hidden: element.hidden,
    inert: element.inert,
    isRoot: element === root,
    rect: inputProbeRect(element.getBoundingClientRect()),
    styleContain: style?.contain,
    styleContentVisibility: style?.contentVisibility,
    styleDisplay: style?.display,
    styleOpacity: style?.opacity,
    styleOverflow: style?.overflow,
    stylePointerEvents: style?.pointerEvents,
    stylePosition: style?.position,
    styleTransform: style?.transform,
    styleUserSelect: style?.userSelect,
    styleVisibility: style?.visibility,
    tabIndex: element.tabIndex,
  };
}

function inputProbePendingFallback(
  pending: PendingKeyboardTextFallback | null,
): InputProbeExtra | null {
  if (!pending) return null;

  return {
    nativeInputGeneration: pending.nativeInputGeneration,
    startMs: pending.startMs,
    text: pending.text,
    textLength: pending.text.length,
    timerId: pending.timerId,
  };
}

export class InputSelectionController {
  private mouseSelectionDrag: MouseSelectionDrag | null = null;
  private mouseSelectionAutoScrollFrame = 0;
  private useSessionSelectionForNextInput = false;
  private nativeInputGeneration = 0;
  private nativeTextInputState: NativeTextInputState = "unknown";
  private nativeInputHandlersInstalled = false;
  private pendingKeyboardTextFallback: PendingKeyboardTextFallback | null = null;

  constructor(private readonly options: InputSelectionControllerOptions) {}

  install(): void {
    const { el } = this.options;
    el.addEventListener("mousedown", this.handleMouseDown);
    el.addEventListener("beforeinput", this.handleBeforeInput);
    el.addEventListener("copy", this.handleCopy);
    el.addEventListener("drop", this.handleDrop);
    el.addEventListener("paste", this.handlePaste);
    el.addEventListener("keypress", this.handleKeyPressCaptureProbe, { capture: true });
    el.addEventListener("keypress", this.handleKeyPressBubbleProbe);
    el.addEventListener("keydown", this.handleKeyDown);
    el.addEventListener("keyup", this.syncSessionSelectionFromDom);
    el.addEventListener("mouseup", this.syncSessionSelectionFromDom);
    el.ownerDocument.addEventListener("selectionchange", this.syncCustomSelectionFromDom);
    this.installGlobalInputProbes();
  }

  dispose(): void {
    const { el } = this.options;
    this.cancelPendingKeyboardTextFallback("dispose");
    this.removeGlobalInputProbes();
    this.uninstallNativeInputHandlers();
    el.removeEventListener("mousedown", this.handleMouseDown);
    el.removeEventListener("beforeinput", this.handleBeforeInput);
    el.removeEventListener("copy", this.handleCopy);
    el.removeEventListener("drop", this.handleDrop);
    el.removeEventListener("paste", this.handlePaste);
    el.removeEventListener("keypress", this.handleKeyPressCaptureProbe, { capture: true });
    el.removeEventListener("keypress", this.handleKeyPressBubbleProbe);
    el.removeEventListener("keydown", this.handleKeyDown);
    el.removeEventListener("keyup", this.syncSessionSelectionFromDom);
    el.removeEventListener("mouseup", this.syncSessionSelectionFromDom);
    el.ownerDocument.removeEventListener("selectionchange", this.syncCustomSelectionFromDom);
    this.stopMouseSelectionDrag();
  }

  syncNativeInputHandlers(editable: boolean): void {
    if (editable) {
      this.installNativeInputHandlers();
      return;
    }

    this.uninstallNativeInputHandlers();
  }

  applyHistoryCommand(command: "undo" | "redo", context: EditorCommandContext): boolean {
    const session = this.session;
    if (!session) return false;
    if (!this.options.canEditDocument()) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = command === "undo" ? session.undo() : session.redo();
    this.options.applySessionChange(
      change,
      command === "undo" ? "input.undo" : "input.redo",
      start,
    );
    return true;
  }

  applyDeleteCommand(direction: "backward" | "forward", context: EditorCommandContext): boolean {
    const session = this.session;
    if (!session) return false;
    if (!this.options.canEditDocument()) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const selectionChange = this.selectionChangeBeforeEdit();
    const change = direction === "backward" ? session.backspace() : session.deleteSelection();
    this.options.applySessionChange(
      mergeChangeTimings(change, selectionChange),
      direction === "backward" ? "input.backspace" : "input.delete",
      start,
    );
    return true;
  }

  applyIndentCommand(direction: "indent" | "outdent", context: EditorCommandContext): boolean {
    const session = this.session;
    if (!session) return false;
    if (!this.options.canEditDocument()) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const selectionChange = this.selectionChangeBeforeEdit();
    const change =
      direction === "indent"
        ? this.applyIndentToSession()
        : session.outdentSelection(this.options.tabSize);
    const merged = mergeChangeTimings(change, selectionChange);
    this.options.applySessionChange(merged, indentTimingName(direction), start, {
      revealOffset: this.primarySelectionHeadOffset(merged),
    });
    return true;
  }

  applyEditActionCommand(
    command: EditorEditActionCommandId,
    context: EditorCommandContext,
  ): boolean {
    const session = this.session;
    if (!session) return false;
    if (!this.options.canEditDocument()) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const selectionChange = this.selectionChangeBeforeEdit();
    const snapshot = session.getSnapshot();
    const selections = session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection));
    const action = editActionForCommand(command, session.getText(), selections, {
      languageId: this.options.getLanguageId(),
      tabSize: this.options.tabSize,
    });
    const change = session.applyEdits(action.edits, {
      selections: action.selections,
    });
    this.options.applySessionChange(
      mergeChangeTimings(change, selectionChange),
      action.timingName,
      start,
      {
        revealOffset: action.revealOffset,
      },
    );
    return true;
  }

  applySelectAllCommand(context: EditorCommandContext): boolean {
    const session = this.session;
    if (!session) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = session.setSelection(0, session.getSnapshot().length);
    this.syncCustomSelectionHighlight(0, session.getSnapshot().length);
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, "input.selectAll", start, { syncDomSelection: false });
    return true;
  }

  applyClearSecondarySelections(context: EditorCommandContext): boolean {
    const session = this.session;
    if (!session) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = session.clearSecondarySelections();
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, "input.clearSecondarySelections", start, {
      syncDomSelection: false,
    });
    return true;
  }

  applyInsertCursorCommand(direction: "above" | "below", context: EditorCommandContext): boolean {
    const session = this.session;
    if (!session) return false;

    const resolved = this.resolvedSelections();
    const rowDelta = direction === "above" ? -1 : 1;
    const inserted = resolved
      .map((selection) => this.cursorSelectionByDisplayRows(selection, rowDelta))
      .filter((selection) => selection.anchor !== selection.sourceHead);
    if (inserted.length === 0) return false;

    const selections = [
      ...resolved.map((selection) => ({
        anchor: selection.anchorOffset,
        head: selection.headOffset,
        goal: selection.goal,
      })),
      ...inserted.map((selection) => ({
        anchor: selection.anchor,
        head: selection.anchor,
        goal: selection.goal,
      })),
    ];
    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = session.setSelections(selections);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, `input.insertCursor${capitalize(direction)}`, start, {
      revealOffset: inserted[0]?.anchor,
      syncDomSelection: false,
    });
    return true;
  }

  applySelectExactOccurrencesCommand(
    command: "editor.action.selectHighlights" | "editor.action.changeAll",
    context: EditorCommandContext,
  ): boolean {
    const session = this.session;
    if (!session) return false;

    const text = session.getText();
    const query = this.occurrenceQueryForCurrentSelection(text);
    if (!query) return false;

    const ranges = findAllExactOccurrences(text, query.query);
    if (ranges.length === 0) return false;

    const selections = ranges.map((range) => ({ anchor: range.start, head: range.end }));
    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = session.setSelections(selections);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, occurrenceSelectTimingName(command), start, {
      revealOffset: query.range.end,
      syncDomSelection: false,
    });
    return true;
  }

  applyMoveSelectionToNextOccurrenceCommand(context: EditorCommandContext): boolean {
    const session = this.session;
    if (!session) return false;

    const text = session.getText();
    const resolved = this.resolvedSelections();
    const source = resolved.at(-1);
    if (!source) return false;

    const query = occurrenceQueryForSelection(text, source);
    if (!query) return false;

    const keptSelections = resolved.slice(0, -1);
    const selected = keptSelections.map((selection) => ({
      start: selection.startOffset,
      end: selection.endOffset,
    }));
    const next = findNextExactOccurrenceFromRange(text, query.query, selected, query.range);
    if (!next) return false;
    if (next.start === query.range.start && next.end === query.range.end) return false;

    const selections = [
      ...keptSelections.map((selection) => ({
        anchor: selection.anchorOffset,
        head: selection.headOffset,
        goal: selection.goal,
      })),
      { anchor: next.start, head: next.end },
    ];
    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = session.setSelections(selections);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, "input.moveSelectionToNextFindMatch", start, {
      revealOffset: next.end,
      syncDomSelection: false,
    });
    return true;
  }

  applyAddNextOccurrenceCommand(context: EditorCommandContext): boolean {
    const start = context.event ? eventStartMs(context.event) : nowMs();
    const result = this.addNextExactOccurrence();
    if (!result) return false;

    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(result.change, "input.addNextOccurrence", start, {
      revealOffset: result.revealOffset,
      syncDomSelection: false,
    });
    return true;
  }

  applyNavigationCommand(command: EditorCommandId, context: EditorCommandContext): boolean {
    const session = this.session;
    if (!session) return false;

    const snapshot = session.getSnapshot();
    const text = session.getText();
    const resolvedSelections = session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection));
    if (resolvedSelections.length === 0) return false;

    const navigation = resolvedSelections.map((resolved) => ({
      resolved,
      target: navigationTargetForCommand({
        command,
        resolved,
        text,
        documentLength: snapshot.length,
        view: this.options.view,
      }),
    }));
    const primary = navigation[0];
    if (!primary?.target) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const selections = [];
    for (const { resolved, target } of navigation) {
      if (!target) return false;
      selections.push({
        anchor: target.extend ? resolved.anchorOffset : target.offset,
        head: target.offset,
        goal: target.goal ?? SelectionGoal.none(),
      });
    }
    const change = session.setSelections(selections);
    this.useSessionSelectionForNextInput = true;
    this.options.view.revealOffset(primary.target.offset);
    this.options.applySessionChange(change, primary.target.timingName, start);
    return true;
  }

  applyFindSelection(
    anchorOffset: number,
    headOffset: number,
    timingName: string,
    revealOffset?: number,
  ): void {
    const session = this.session;
    if (!session) return;

    const start = nowMs();
    const change = session.setSelection(anchorOffset, headOffset);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, timingName, start, {
      revealOffset,
      syncDomSelection: false,
    });
  }

  applyFindSelections(
    selections: readonly EditorSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void {
    const session = this.session;
    if (!session) return;
    if (selections.length === 0) return;

    const start = nowMs();
    const change = session.setSelections(selections);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, timingName, start, {
      revealOffset,
      syncDomSelection: false,
    });
  }

  applyFindEdits(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: EditorSelectionRange,
  ): void {
    const session = this.session;
    if (!session) return;
    if (!this.options.canEditDocument()) return;
    if (edits.length === 0) return;

    const start = nowMs();
    const change = session.applyEdits(edits, { selection });
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, timingName, start, {
      revealOffset: this.primarySelectionHeadOffset(change),
      syncDomSelection: false,
    });
  }

  resolveViewSelections(): readonly EditorResolvedSelection[] {
    const snapshot = this.session?.getSnapshot();
    const selections = this.session?.getSelections().selections ?? [];
    if (!snapshot) return [];

    return selections.map((selection) => {
      const resolved = resolveSelection(snapshot, selection);
      return {
        anchorOffset: resolved.anchorOffset,
        headOffset: resolved.headOffset,
        startOffset: resolved.startOffset,
        endOffset: resolved.endOffset,
      };
    });
  }

  syncDomSelection(): void {
    const session = this.session;
    if (!session) return;

    const selection = session.getSelections().selections[0];
    if (!selection) return;

    const resolved = resolveSelection(session.getSnapshot(), selection);
    const start = clamp(resolved.startOffset, 0, this.text.length);
    const end = clamp(resolved.endOffset, start, this.text.length);

    if (this.hasFocusedExternalElement()) {
      this.syncSessionSelectionHighlight();
      this.options.notifyViewContributions("selection", null);
      return;
    }

    if (this.isInputFocused()) {
      this.syncSessionSelectionHighlight();
      this.options.notifyViewContributions("selection", null);
      return;
    }

    if (this.options.selectionSyncMode === "none") {
      this.syncSessionSelectionHighlight();
      this.options.notifyViewContributions("selection", null);
      return;
    }

    const range = this.options.view.createRange(start, end, { scrollIntoView: false });
    const domSelection = window.getSelection();
    domSelection?.removeAllRanges();
    if (range) domSelection?.addRange(range);
    this.syncSessionSelectionHighlight();
    this.options.notifyViewContributions("selection", null);
  }

  syncSessionSelectionHighlight(): void {
    const session = this.session;
    if (!session) return;

    const snapshot = session.getSnapshot();
    const selections = session.getSelections().selections.map((selection) => {
      const resolved = resolveSelection(snapshot, selection);
      return {
        anchorOffset: resolved.anchorOffset,
        headOffset: resolved.headOffset,
      };
    });
    this.options.view.setSelections(selections);
  }

  clearSelectionHighlight(): void {
    this.options.view.clearSelection();
  }

  textOffsetFromPoint(clientX: number, clientY: number): number | null {
    return (
      this.options.view.textOffsetFromPoint(clientX, clientY) ??
      this.options.view.textOffsetFromViewportPoint(clientX, clientY)
    );
  }

  rangeClientRect(start: number, end: number): DOMRect | null {
    const range = this.options.view.createRange(start, Math.max(start, end), {
      scrollIntoView: false,
    });
    if (!range) return null;

    const firstRect = range.getClientRects()[0];
    if (firstRect) return firstRect;

    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return rect;
    return null;
  }

  private get session(): DocumentSession | null {
    return this.options.getSession();
  }

  private get text(): string {
    return this.options.getText();
  }

  private installGlobalInputProbes(): void {
    const document = this.options.el.ownerDocument;
    const window = document.defaultView;
    for (const type of INPUT_PROBE_GLOBAL_EVENT_TYPES) {
      document.addEventListener(type, this.handleDocumentInputProbeCapture, { capture: true });
      document.addEventListener(type, this.handleDocumentInputProbeBubble);
      window?.addEventListener(type, this.handleWindowInputProbeCapture, { capture: true });
      window?.addEventListener(type, this.handleWindowInputProbeBubble);
    }
  }

  private removeGlobalInputProbes(): void {
    const document = this.options.el.ownerDocument;
    const window = document.defaultView;
    for (const type of INPUT_PROBE_GLOBAL_EVENT_TYPES) {
      document.removeEventListener(type, this.handleDocumentInputProbeCapture, { capture: true });
      document.removeEventListener(type, this.handleDocumentInputProbeBubble);
      window?.removeEventListener(type, this.handleWindowInputProbeCapture, { capture: true });
      window?.removeEventListener(type, this.handleWindowInputProbeBubble);
    }
  }

  private installNativeInputHandlers(): void {
    if (this.nativeInputHandlersInstalled) return;

    this.options.view.inputElement.addEventListener(
      "beforeinput",
      this.handleNativeInputBeforeInputCapture,
      {
        capture: true,
      },
    );
    this.options.view.inputElement.addEventListener("input", this.handleNativeInputInputCapture, {
      capture: true,
    });
    this.nativeInputHandlersInstalled = true;
  }

  private uninstallNativeInputHandlers(): void {
    if (!this.nativeInputHandlersInstalled) return;

    this.options.view.inputElement.removeEventListener(
      "beforeinput",
      this.handleNativeInputBeforeInputCapture,
      { capture: true },
    );
    this.options.view.inputElement.removeEventListener(
      "input",
      this.handleNativeInputInputCapture,
      {
        capture: true,
      },
    );
    this.nativeInputHandlersInstalled = false;
  }

  private handleNativeInputBeforeInputCapture = (_event: InputEvent): void => {
    this.logInputProbe("native.beforeinput.capture", _event, {
      nextNativeInputGeneration: this.nativeInputGeneration + 1,
    });
    this.nativeInputGeneration += 1;
    this.nativeTextInputState = "observed";
    this.cancelPendingKeyboardTextFallback("native.beforeinput.capture");
  };

  private handleNativeInputInputCapture = (event: Event): void => {
    this.logInputProbe("native.input.capture", event, {
      nextNativeInputGeneration: this.nativeInputGeneration + 1,
    });
    this.nativeInputGeneration += 1;
    this.nativeTextInputState = "observed";
    this.cancelPendingKeyboardTextFallback("native.input.capture");
  };

  private handleDocumentInputProbeCapture = (event: Event): void => {
    this.logGlobalInputProbe("document", "capture", event);
  };

  private handleDocumentInputProbeBubble = (event: Event): void => {
    this.logGlobalInputProbe("document", "bubble", event);
  };

  private handleWindowInputProbeCapture = (event: Event): void => {
    this.logGlobalInputProbe("window", "capture", event);
  };

  private handleWindowInputProbeBubble = (event: Event): void => {
    this.logGlobalInputProbe("window", "bubble", event);
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.session) return;
    if (event.defaultPrevented) return;
    if (eventTargetInsideBlockSurface(event.target)) return;

    this.options.view.focusInput();
    if (event.detail >= 4) {
      this.selectFullDocument(event, "input.quadClick");
      return;
    }

    const offset = this.textOffsetFromMouseEvent(event);
    if (offset === null) return;

    if (event.detail === 3) {
      this.selectLineAtOffset(event, offset);
      return;
    }

    if (event.detail === 2) {
      this.selectWordAtOffset(event, offset);
      return;
    }

    if (event.altKey) {
      this.addCursorAtOffset(event, offset);
      return;
    }

    this.startMouseSelectionDrag(event, offset);
  };

  private addCursorAtOffset(event: MouseEvent, offset: number): void {
    const session = this.session;
    if (!session) return;
    if (event.button !== 0) return;
    if (event.detail !== 1) return;

    const start = eventStartMs(event);
    event.preventDefault();
    const change = session.addSelection(offset);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, "input.addCursor", start, {
      syncDomSelection: false,
    });
  }

  private startMouseSelectionDrag(event: MouseEvent, offset: number): void {
    if (event.button !== 0) return;
    if (event.detail !== 1) return;

    event.preventDefault();
    this.options.view.focusInput();
    this.mouseSelectionDrag = {
      anchorOffset: offset,
      headOffset: offset,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    this.syncCustomSelectionHighlight(offset, offset);
    this.options.el.ownerDocument.addEventListener("mousemove", this.updateMouseSelectionDrag);
    this.options.el.ownerDocument.addEventListener("mouseup", this.finishMouseSelectionDrag);
  }

  private updateMouseSelectionDrag = (event: MouseEvent): void => {
    if (!this.mouseSelectionDrag) return;
    if (!this.session) return;

    event.preventDefault();
    this.mouseSelectionDrag.clientX = event.clientX;
    this.mouseSelectionDrag.clientY = event.clientY;
    this.updateMouseSelectionFromDragPoint();
    this.updateMouseSelectionAutoScroll();
  };

  private finishMouseSelectionDrag = (event: MouseEvent): void => {
    const drag = this.mouseSelectionDrag;
    const session = this.session;
    if (!drag || !session) {
      this.stopMouseSelectionDrag();
      return;
    }

    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    const offset = this.mouseSelectionOffsetFromPoint(drag.clientX, drag.clientY);
    event.preventDefault();
    this.stopMouseSelectionDrag();

    const start = nowMs();
    const change = session.setSelection(drag.anchorOffset, offset);
    const syncDomSelection = drag.anchorOffset === offset;
    this.syncCustomSelectionHighlight(drag.anchorOffset, offset);
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, "input.selection", start, { syncDomSelection });
  };

  private stopMouseSelectionDrag(): void {
    this.mouseSelectionDrag = null;
    this.stopMouseSelectionAutoScroll();
    this.options.el.ownerDocument.removeEventListener("mousemove", this.updateMouseSelectionDrag);
    this.options.el.ownerDocument.removeEventListener("mouseup", this.finishMouseSelectionDrag);
  }

  private updateMouseSelectionFromDragPoint(): void {
    const drag = this.mouseSelectionDrag;
    const session = this.session;
    if (!drag || !session) return;

    const offset = this.mouseSelectionOffsetFromPoint(drag.clientX, drag.clientY);
    drag.headOffset = offset;
    this.syncCustomSelectionHighlight(drag.anchorOffset, offset);
    session.setSelection(drag.anchorOffset, offset);
    this.options.notifyViewContributions("selection", null);
    this.useSessionSelectionForNextInput = drag.anchorOffset !== offset;
  }

  private mouseSelectionOffsetFromPoint(clientX: number, clientY: number): number {
    const offset =
      this.options.view.textOffsetFromPoint(clientX, clientY) ??
      this.options.view.textOffsetFromViewportPoint(clientX, clientY);
    if (offset !== null) return offset;

    return this.mouseSelectionDrag?.headOffset ?? 0;
  }

  private updateMouseSelectionAutoScroll(): void {
    const delta = this.mouseSelectionAutoScrollDelta();
    if (delta === 0 || !this.canMouseSelectionAutoScroll(delta)) {
      this.stopMouseSelectionAutoScroll();
      return;
    }

    this.scrollMouseSelection(delta);
    this.scheduleMouseSelectionAutoScroll();
  }

  private mouseSelectionAutoScrollDelta(): number {
    const drag = this.mouseSelectionDrag;
    if (!drag) return 0;

    const rect = this.options.el.getBoundingClientRect();
    return mouseSelectionAutoScrollDelta(drag.clientY, rect);
  }

  private canMouseSelectionAutoScroll(delta: number): boolean {
    const maxScrollTop = Math.max(0, this.options.el.scrollHeight - this.options.el.clientHeight);
    if (delta < 0) return this.options.el.scrollTop > 0;
    if (delta > 0) return this.options.el.scrollTop < maxScrollTop;
    return false;
  }

  private scrollMouseSelection(delta: number): void {
    const maxScrollTop = Math.max(0, this.options.el.scrollHeight - this.options.el.clientHeight);
    const nextScrollTop = clamp(this.options.el.scrollTop + delta, 0, maxScrollTop);
    if (nextScrollTop === this.options.el.scrollTop) return;

    this.options.el.scrollTop = nextScrollTop;
    this.options.view.setScrollMetrics(this.options.el.scrollTop, this.options.el.clientHeight);
    this.updateMouseSelectionFromDragPoint();
  }

  private scheduleMouseSelectionAutoScroll(): void {
    if (this.mouseSelectionAutoScrollFrame !== 0) return;

    this.mouseSelectionAutoScrollFrame = requestFrame(() => {
      this.mouseSelectionAutoScrollFrame = 0;
      if (!this.mouseSelectionDrag) return;
      this.updateMouseSelectionAutoScroll();
    });
  }

  private stopMouseSelectionAutoScroll(): void {
    if (this.mouseSelectionAutoScrollFrame === 0) return;

    cancelFrame(this.mouseSelectionAutoScrollFrame);
    this.mouseSelectionAutoScrollFrame = 0;
  }

  private selectFullDocument(event: MouseEvent, timingName: string): void {
    const session = this.session;
    if (!session) return;

    const start = eventStartMs(event);
    event.preventDefault();
    const change = session.setSelection(0, session.getSnapshot().length);
    this.syncCustomSelectionHighlight(0, session.getSnapshot().length);
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, timingName, start, { syncDomSelection: false });
  }

  private selectLineAtOffset(event: MouseEvent, offset: number): void {
    const session = this.session;
    if (!session) return;

    const range = lineRangeAtOffset(session.getText(), offset);
    this.selectRange(event, range, "input.tripleClick");
  }

  private selectWordAtOffset(event: MouseEvent, offset: number): void {
    const session = this.session;
    if (!session) return;

    const range = wordRangeAtOffset(session.getText(), offset);
    if (range.start === range.end) return;

    this.selectRange(event, range, "input.doubleClick");
  }

  private selectRange(
    event: MouseEvent,
    range: { readonly start: number; readonly end: number },
    timingName: string,
  ): void {
    const session = this.session;
    if (!session) return;

    const start = eventStartMs(event);
    event.preventDefault();
    const change = session.setSelection(range.start, range.end);
    this.syncCustomSelectionHighlight(range.start, range.end);
    this.useSessionSelectionForNextInput = true;
    this.options.applySessionChange(change, timingName, start, { syncDomSelection: false });
  }

  private handleBeforeInput = (event: InputEvent): void => {
    const session = this.session;
    this.logInputProbe("beforeinput.root.enter", event, {
      hasSession: session !== null,
    });
    if (!session) {
      this.logInputProbe("beforeinput.root.skip.noSession", event);
      return;
    }
    if (!this.options.canEditDocument()) {
      this.logInputProbe("beforeinput.root.skip.readonly", event);
      this.cancelPendingKeyboardTextFallback("beforeinput.readonly");
      event.preventDefault();
      return;
    }

    const text = event.data ?? "";
    if (event.inputType !== "insertText" && event.inputType !== "insertLineBreak") {
      this.logInputProbe("beforeinput.root.skip.inputType", event, {
        inputType: event.inputType,
      });
      return;
    }

    this.cancelPendingKeyboardTextFallback("beforeinput.apply");
    const start = eventStartMs(event);
    const selectionChange = this.selectionChangeBeforeEdit();
    event.preventDefault();
    const inserted = event.inputType === "insertLineBreak" ? "\n" : text;
    this.logInputProbe("beforeinput.root.apply", event, {
      inserted,
      selectionChangeKind: selectionChange?.kind ?? null,
    });
    this.options.applySessionChange(
      mergeChangeTimings(session.applyText(inserted), selectionChange),
      "input.beforeinput",
      start,
    );
  };

  private handlePaste = (event: ClipboardEvent): void => {
    const session = this.session;
    if (!session) return;
    if (!this.options.canEditDocument()) {
      event.preventDefault();
      return;
    }

    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;

    const start = eventStartMs(event);
    const selectionChange = this.selectionChangeBeforeEdit();
    event.preventDefault();
    const change = mergeChangeTimings(session.applyText(text), selectionChange);
    this.options.applySessionChange(change, "input.paste", start, {
      revealBlock: "end",
      revealOffset: this.primarySelectionHeadOffset(change),
    });
  };

  private handleDrop = (event: DragEvent): void => {
    if (this.options.canEditDocument()) return;

    event.preventDefault();
  };

  private handleCopy = (event: ClipboardEvent): void => {
    const text = this.selectedTextForClipboard();
    if (text === null) return;
    if (!event.clipboardData) return;

    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    const session = this.session;
    const canEditDocument = this.options.canEditDocument();
    this.logInputProbe("keydown.enter", event, {
      canEditDocument,
      hasSession: session !== null,
    });
    if (!session) {
      this.logKeyDownAfterDispatch(event, "noSession");
      return;
    }
    if (!canEditDocument) {
      this.logKeyDownAfterDispatch(event, "readonly");
      return;
    }

    const fallbackText = keyboardFallbackText(event);
    if (fallbackText === null) {
      this.logInputProbe("keydown.skip.noFallbackText", event);
      this.logKeyDownAfterDispatch(event, "noFallbackText");
      return;
    }

    if (this.canWaitForNativeTextInput(event, fallbackText)) {
      this.logInputProbe("keydown.waitForNative", event, { fallbackText });
      this.scheduleKeyboardTextFallback(event, fallbackText);
      this.logKeyDownAfterDispatch(event, "waitForNative");
      return;
    }

    this.logInputProbe("keydown.applySyncFallback", event, { fallbackText });
    event.preventDefault();
    this.flushPendingKeyboardTextFallback();
    this.applyKeyboardTextFallback(fallbackText, eventStartMs(event));
    if (event.target !== this.options.view.inputElement) this.options.view.focusInput();
    this.logKeyDownAfterDispatch(event, "syncFallback");
  };

  private handleKeyPressCaptureProbe = (event: KeyboardEvent): void => {
    this.logInputProbe("keypress.capture", event, {
      eventPhase: event.eventPhase,
    });
    this.logKeyPressAfterDispatch(event, "capture");
  };

  private handleKeyPressBubbleProbe = (event: KeyboardEvent): void => {
    this.logInputProbe("keypress.bubble", event, {
      eventPhase: event.eventPhase,
    });
    this.logKeyPressAfterDispatch(event, "bubble");
  };

  private canWaitForNativeTextInput(event: KeyboardEvent, text: string): boolean {
    if (text === " ") return false;
    if (this.nativeTextInputState === "missing") return false;
    return event.target === this.options.view.inputElement;
  }

  private scheduleKeyboardTextFallback(event: KeyboardEvent, text: string): void {
    const start = eventStartMs(event);
    const nativeInputGeneration = this.nativeInputGeneration;
    const pending = this.pendingKeyboardTextFallback;

    if (pending && pending.nativeInputGeneration === nativeInputGeneration) {
      pending.text += text;
      pending.startMs = Math.min(pending.startMs, start);
      this.logInputProbe("fallback.coalesce", event, {
        nativeInputGeneration,
        pendingText: pending.text,
        text,
      });
      return;
    }

    const view = this.options.el.ownerDocument.defaultView;
    if (!view) {
      this.logInputProbe("fallback.schedule.skip.noWindow", event, { text });
      return;
    }

    this.cancelPendingKeyboardTextFallback("fallback.schedule.replace");
    const next: PendingKeyboardTextFallback = {
      timerId: 0,
      nativeInputGeneration,
      startMs: start,
      text,
    };
    next.timerId = view.setTimeout(() => {
      this.logInputProbe("fallback.timer.fire", undefined, {
        expectedTimerId: next.timerId,
        expectedText: next.text,
        expectedNativeInputGeneration: next.nativeInputGeneration,
      });
      this.flushPendingKeyboardTextFallback(next);
    }, 0);
    this.pendingKeyboardTextFallback = next;
    this.logInputProbe("fallback.schedule", event, {
      nativeInputGeneration,
      text,
      timerId: next.timerId,
    });
  }

  private cancelPendingKeyboardTextFallback(reason = "cancel"): void {
    const pending = this.pendingKeyboardTextFallback;
    if (!pending) {
      this.logInputProbe("fallback.cancel.none", undefined, { reason });
      return;
    }

    this.pendingKeyboardTextFallback = null;
    this.options.el.ownerDocument.defaultView?.clearTimeout(pending.timerId);
    this.logInputProbe("fallback.cancel", undefined, {
      pendingNativeInputGeneration: pending.nativeInputGeneration,
      pendingText: pending.text,
      reason,
      timerId: pending.timerId,
    });
  }

  private flushPendingKeyboardTextFallback(expected?: PendingKeyboardTextFallback): void {
    const pending = this.pendingKeyboardTextFallback;
    if (!pending) {
      this.logInputProbe("fallback.flush.skip.none", undefined, {
        expectedTimerId: expected?.timerId,
      });
      return;
    }
    if (expected && pending !== expected) {
      this.logInputProbe("fallback.flush.skip.stale", undefined, {
        expectedTimerId: expected.timerId,
        pendingTimerId: pending.timerId,
      });
      return;
    }

    this.pendingKeyboardTextFallback = null;
    this.options.el.ownerDocument.defaultView?.clearTimeout(pending.timerId);
    this.logInputProbe("fallback.flush.apply", undefined, {
      pendingNativeInputGeneration: pending.nativeInputGeneration,
      pendingText: pending.text,
      timerId: pending.timerId,
    });
    this.applyKeyboardTextFallback(pending.text, pending.startMs, pending.nativeInputGeneration);
  }

  private applyKeyboardTextFallback(
    text: string,
    start: number,
    nativeInputGeneration?: number,
  ): void {
    const session = this.session;
    this.logInputProbe("fallback.apply.enter", undefined, {
      expectedNativeInputGeneration: nativeInputGeneration,
      text,
    });
    if (!session) {
      this.logInputProbe("fallback.apply.skip.noSession", undefined, { text });
      return;
    }
    if (!this.options.canEditDocument()) {
      this.logInputProbe("fallback.apply.skip.readonly", undefined, { text });
      return;
    }
    if (
      nativeInputGeneration !== undefined &&
      this.nativeInputGeneration !== nativeInputGeneration
    ) {
      this.logInputProbe("fallback.apply.skip.nativeGenerationChanged", undefined, {
        currentNativeInputGeneration: this.nativeInputGeneration,
        expectedNativeInputGeneration: nativeInputGeneration,
        text,
      });
      return;
    }

    if (nativeInputGeneration !== undefined) this.nativeTextInputState = "missing";
    const selectionChange = this.selectionChangeBeforeEdit();
    this.options.view.inputElement.value = "";
    this.logInputProbe("fallback.apply.commit", undefined, {
      selectionChangeKind: selectionChange?.kind ?? null,
      text,
    });
    this.options.applySessionChange(
      mergeChangeTimings(session.applyText(text), selectionChange),
      "input.keydownFallback",
      start,
    );
  }

  private applyIndentToSession(): DocumentSessionChange {
    const session = this.session;
    if (!session) throw new Error("missing editor session");
    if (this.shouldInsertLiteralTab()) return session.applyText("\t");
    return session.indentSelection("\t");
  }

  private shouldInsertLiteralTab(): boolean {
    const session = this.session;
    if (!session) return false;

    const snapshot = session.getSnapshot();
    const selections = session.getSelections().selections;
    return selections.every((selection) => resolveSelection(snapshot, selection).collapsed);
  }

  private cursorSelectionByDisplayRows(
    selection: ResolvedSelection,
    rowDelta: -1 | 1,
  ): {
    readonly anchor: number;
    readonly goal: SelectionGoalValue;
    readonly sourceHead: number;
  } {
    const visualColumn = selectionGoalColumn(selection, this.options.view);
    return {
      anchor: this.options.view.offsetByDisplayRows(selection.headOffset, rowDelta, visualColumn),
      goal: SelectionGoal.horizontal(visualColumn),
      sourceHead: selection.headOffset,
    };
  }

  private resolvedSelections(): readonly ResolvedSelection[] {
    const session = this.session;
    if (!session) return [];

    const snapshot = session.getSnapshot();
    return session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection));
  }

  private addNextExactOccurrence(): OccurrenceSelectionChange | null {
    const session = this.session;
    if (!session) return null;

    const text = session.getText();
    const resolved = this.resolvedSelections();
    const primary = resolved[0];
    if (!primary) return null;

    if (resolved.length === 1 && primary.collapsed) {
      return this.selectCurrentWordForOccurrence(text, primary);
    }

    const query = getOccurrenceQuery(text, resolved);
    if (!query) return null;

    const range = findNextExactOccurrence(text, query, resolved);
    if (!range) return null;

    const selections = [
      ...resolved.map((selection) => ({
        anchor: selection.anchorOffset,
        head: selection.headOffset,
      })),
      { anchor: range.start, head: range.end },
    ];
    return {
      change: session.setSelections(selections),
      revealOffset: range.end,
    };
  }

  private occurrenceQueryForCurrentSelection(text: string): OccurrenceQuery | null {
    const resolved = this.resolvedSelections();
    const selected = resolved.find((selection) => !selection.collapsed);
    if (selected) return occurrenceQueryForSelection(text, selected);

    const primary = resolved[0];
    if (!primary) return null;
    return occurrenceQueryForSelection(text, primary);
  }

  private selectCurrentWordForOccurrence(
    text: string,
    selection: ResolvedSelection,
  ): OccurrenceSelectionChange | null {
    const session = this.session;
    if (!session) return null;

    const range = wordRangeAtOffset(text, selection.headOffset);
    if (range.start === range.end) return null;

    return {
      change: session.setSelection(range.start, range.end),
      revealOffset: range.end,
    };
  }

  private selectedTextForClipboard(): string | null {
    const session = this.session;
    if (!session) return null;

    const snapshot = session.getSnapshot();
    const texts = session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection))
      .filter((selection) => !selection.collapsed)
      .map((selection) => getPieceTableText(snapshot, selection.startOffset, selection.endOffset));
    if (texts.length === 0) return null;

    return texts.join("\n");
  }

  private primarySelectionHeadOffset(change: DocumentSessionChange): number | undefined {
    const selection = change.selections.selections[0];
    if (!selection) return undefined;

    return resolveSelection(change.snapshot, selection).headOffset;
  }

  private syncSessionSelectionFromDom = (_event: Event): void => {
    if (!this.session) return;
    if (this.mouseSelectionDrag) return;
    if (this.useSessionSelectionForNextInput) return;
    if (this.isInputFocused()) return;

    const start = nowMs();
    const change = this.updateSessionSelectionFromDom();
    if (!change) return;

    this.useSessionSelectionForNextInput = false;
    const timedChange = appendTiming(change, "input.selection", start);
    this.options.getSessionOptions().onChange?.(timedChange);
    this.options.notifyViewContributions("selection", null);
    this.options.notifyChangeWithTiming(timedChange);
  };

  private updateSessionSelectionFromDom(): DocumentSessionChange | null {
    const session = this.session;
    if (!session) return null;

    const readStart = nowMs();
    const offsets = this.readDomSelectionOffsets();
    if (!offsets) return null;

    this.syncCustomSelectionHighlight(offsets.anchorOffset, offsets.headOffset);
    return appendTiming(
      session.setSelection(offsets.anchorOffset, offsets.headOffset),
      "editor.readDomSelection",
      readStart,
    );
  }

  private selectionChangeBeforeEdit(): DocumentSessionChange | null {
    if (this.isInputFocused()) {
      this.useSessionSelectionForNextInput = false;
      return null;
    }
    if (!this.useSessionSelectionForNextInput) return this.updateSessionSelectionFromDom();

    this.useSessionSelectionForNextInput = false;
    return null;
  }

  private readDomSelectionOffsets(): { anchorOffset: number; headOffset: number } | null {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) return null;

    const anchorOffset = this.domBoundaryToTextOffset(selection.anchorNode, selection.anchorOffset);
    const headOffset = this.domBoundaryToTextOffset(selection.focusNode, selection.focusOffset);
    if (anchorOffset === null || headOffset === null) return null;

    return { anchorOffset, headOffset };
  }

  private syncCustomSelectionFromDom = (): void => {
    if (!this.session) return;
    if (this.useSessionSelectionForNextInput) return;
    if (this.isInputFocused()) return;

    const offsets = this.readDomSelectionOffsets();
    if (!offsets) return;

    this.syncCustomSelectionHighlight(offsets.anchorOffset, offsets.headOffset);
  };

  private syncCustomSelectionHighlight(anchorOffset: number, headOffset: number): void {
    this.options.view.setSelection(anchorOffset, headOffset);
  }

  private isInputFocused(): boolean {
    return this.options.el.ownerDocument.activeElement === this.options.view.inputElement;
  }

  private logKeyDownAfterDispatch(event: KeyboardEvent, path: string): void {
    const view = this.options.el.ownerDocument.defaultView;
    view?.queueMicrotask(() => {
      this.logInputProbe("keydown.afterDispatch", event, { path });
    });
  }

  private logKeyPressAfterDispatch(event: KeyboardEvent, phase: string): void {
    const view = this.options.el.ownerDocument.defaultView;
    view?.queueMicrotask(() => {
      this.logInputProbe("keypress.afterDispatch", event, { phase });
    });
  }

  private logGlobalInputProbe(scope: "document" | "window", phase: string, event: Event): void {
    this.logInputProbe(`${scope}.${event.type}.${phase}`, event, {
      eventPhase: event.eventPhase,
      probePhase: phase,
      probeScope: scope,
    });
  }

  private logInputProbe(label: string, event?: Event, extra: InputProbeExtra = {}): void {
    const input = this.options.view.inputElement;
    const activeElement = this.options.el.ownerDocument.activeElement;
    const rootRect = this.options.el.getBoundingClientRect();
    const rootStyle = this.options.el.ownerDocument.defaultView?.getComputedStyle(this.options.el);
    const inputRect = input.getBoundingClientRect();
    const inputStyle = this.options.el.ownerDocument.defaultView?.getComputedStyle(input);
    console.log("[editor-input-probe]", inputProbeStringify({
      label,
      ...inputProbeEventState(event),
      activeElement: inputProbeElementLabel(activeElement),
      activeElementIsEventTarget: event?.target === activeElement,
      canEditDocument: this.options.canEditDocument(),
      documentHasFocus: this.options.el.ownerDocument.hasFocus(),
      eventTargetIsInput: event?.target === input,
      hasSession: this.session !== null,
      inputClientHeight: input.clientHeight,
      inputClientWidth: input.clientWidth,
      inputDisabled: input.disabled,
      inputFocused: activeElement === input,
      inputHandlersInstalled: this.nativeInputHandlersInstalled,
      inputInputMode: input.inputMode,
      inputIsConnected: input.isConnected,
      inputMatchesReadWrite: inputProbeMatches(input, ":read-write"),
      inputMaxLength: input.maxLength,
      inputOffsetParent: inputProbeElementLabel(input.offsetParent),
      inputReadOnly: input.readOnly,
      inputRect: inputProbeRect(inputRect),
      inputScrollHeight: input.scrollHeight,
      inputScrollWidth: input.scrollWidth,
      inputSelectionEnd: input.selectionEnd,
      inputSelectionStart: input.selectionStart,
      inputStyleContain: inputStyle?.contain,
      inputStyleContentVisibility: inputStyle?.contentVisibility,
      inputStyleDisplay: inputStyle?.display,
      inputStyleLeft: inputStyle?.left,
      inputStyleOpacity: inputStyle?.opacity,
      inputStylePointerEvents: inputStyle?.pointerEvents,
      inputStylePosition: inputStyle?.position,
      inputStyleTop: inputStyle?.top,
      inputStyleTransform: inputStyle?.transform,
      inputStyleUserSelect: inputStyle?.userSelect,
      inputStyleVisibility: inputStyle?.visibility,
      inputTabIndex: input.tabIndex,
      inputValue: input.value,
      nativeInputGeneration: this.nativeInputGeneration,
      nativeTextInputState: this.nativeTextInputState,
      pendingKeyboardTextFallback: inputProbePendingFallback(this.pendingKeyboardTextFallback),
      selectionState: inputProbeSelectionState(this.options.el.ownerDocument),
      inputAncestorChain: inputProbeAncestorChain(input, this.options.el),
      rootClientHeight: this.options.el.clientHeight,
      rootClientWidth: this.options.el.clientWidth,
      rootRect: inputProbeRect(rootRect),
      rootScrollHeight: this.options.el.scrollHeight,
      rootScrollLeft: this.options.el.scrollLeft,
      rootScrollTop: this.options.el.scrollTop,
      rootStyleContain: rootStyle?.contain,
      rootStyleContentVisibility: rootStyle?.contentVisibility,
      rootStyleOverflow: rootStyle?.overflow,
      rootStyleTransform: rootStyle?.transform,
      rootStyleUserSelect: rootStyle?.userSelect,
      nowMs: nowMs(),
      ...extra,
    }));
  }

  private hasFocusedExternalElement(): boolean {
    const activeElement = this.options.el.ownerDocument.activeElement;
    if (!activeElement) return false;
    if (activeElement === this.options.el.ownerDocument.body) return false;
    if (activeElement === this.options.el.ownerDocument.documentElement) return false;

    return !this.options.el.contains(activeElement);
  }

  private domBoundaryToTextOffset(node: Node, offset: number): number | null {
    const viewOffset = this.options.view.textOffsetFromDomBoundary(node, offset);
    if (viewOffset !== null) return viewOffset;

    if (node === this.options.el) return elementBoundaryToTextOffset(offset, this.text.length);
    return this.externalBoundaryToTextOffset(node, offset);
  }

  private textOffsetFromMouseEvent(event: MouseEvent): number | null {
    return this.textOffsetFromPoint(event.clientX, event.clientY);
  }

  private externalBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (node.contains(this.options.el)) {
      const child = childContainingNode(node, this.options.el);
      const childIndex = child ? childNodeIndex(node, child) : -1;
      if (childIndex === -1) return null;
      return elementBoundaryToTextOffset(offset <= childIndex ? 0 : 1, this.text.length);
    }

    const position = node.compareDocumentPosition(this.options.el);
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return 0;
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return this.text.length;
    return null;
  }
}
