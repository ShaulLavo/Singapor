import { describe, expect, it } from 'vitest'
import {
  canWaitForNativeTextInput,
  createEditorInputState,
  editorInputStateOwnership,
  hasPendingKeyboardTextFallbackForGeneration,
  pendingKeyboardTextFallback,
  selectionBeforeEditSource,
  shouldCommitCompositionEnd,
  shouldSyncCustomSelectionFromDom,
  shouldSyncSessionSelectionFromDom,
  transitionEditorInputState,
} from '../src/editor/inputState'

describe('editor input state machine', () => {
  it('represents beforeinput, commit, and selection reconciliation transitions', () => {
    let state = createEditorInputState()

    state = transitionEditorInputState(state, { type: 'beforeinput-pending' })
    expect(state.phase).toBe('beforeinput-pending')

    state = transitionEditorInputState(state, { type: 'transaction-committed' })
    expect(state.phase).toBe('transaction-committed')

    state = transitionEditorInputState(state, {
      owner: 'session',
      type: 'selection-reconciled',
    })

    expect(state.phase).toBe('selection-reconciled')
    expect(editorInputStateOwnership(state)).toEqual({
      domSelection: 'editor',
      fallbackGeneration: 'none',
      hiddenInputValue: 'editor',
      pendingText: 'none',
      sessionSelection: 'document-session',
    })
  })

  it('tracks native input generations separately from fallback text', () => {
    let state = createEditorInputState()
    state = transitionEditorInputState(state, {
      generation: state.nativeInputGeneration,
      startMs: 10,
      text: 'A',
      type: 'native-input-wait-started',
    })
    state = transitionEditorInputState(state, {
      startMs: 11,
      text: 'B',
      type: 'native-input-wait-appended',
    })

    expect(state).toMatchObject({
      fallbackGeneration: 0,
      fallbackStartMs: 10,
      pendingText: 'AB',
      phase: 'fallback-pending',
    })
    expect(pendingKeyboardTextFallback(state)).toEqual({
      generation: 0,
      startMs: 10,
      text: 'AB',
    })
    expect(hasPendingKeyboardTextFallbackForGeneration(state, 0)).toBe(true)

    state = transitionEditorInputState(state, { type: 'native-input-observed' })

    expect(state).toMatchObject({
      fallbackGeneration: null,
      nativeInputGeneration: 1,
      nativeTextInputState: 'observed',
      pendingText: '',
      phase: 'native-input-observed',
    })
    expect(pendingKeyboardTextFallback(state)).toBeNull()
  })

  it('makes keyboard fallback waiting explicit', () => {
    let state = createEditorInputState()

    expect(canWaitForNativeTextInput(state, { targetIsHiddenInput: true, text: 'x' })).toBe(true)
    expect(canWaitForNativeTextInput(state, { targetIsHiddenInput: false, text: 'x' })).toBe(false)
    expect(canWaitForNativeTextInput(state, { targetIsHiddenInput: true, text: ' ' })).toBe(false)

    state = transitionEditorInputState(state, { type: 'composition-start' })
    expect(canWaitForNativeTextInput(state, { targetIsHiddenInput: true, text: 'x' })).toBe(false)

    state = transitionEditorInputState(state, { type: 'composition-end' })
    state = transitionEditorInputState(state, {
      generation: state.nativeInputGeneration,
      type: 'native-input-missing',
    })

    expect(canWaitForNativeTextInput(state, { targetIsHiddenInput: true, text: 'x' })).toBe(false)
  })

  it('tracks paste and drop pending text sources', () => {
    let state = createEditorInputState()

    state = transitionEditorInputState(state, { text: 'pasted', type: 'paste-pending' })
    expect(state).toMatchObject({
      pendingText: 'pasted',
      pendingTextSource: 'paste',
      phase: 'beforeinput-pending',
    })

    state = transitionEditorInputState(state, { type: 'transaction-committed' })
    state = transitionEditorInputState(state, { text: 'dropped', type: 'drop-pending' })

    expect(state).toMatchObject({
      pendingText: 'dropped',
      pendingTextSource: 'drop',
      phase: 'beforeinput-pending',
    })
  })

  it('commits compositionend only when composition text was not already handled', () => {
    let state = createEditorInputState()

    state = transitionEditorInputState(state, { type: 'composition-start' })
    state = transitionEditorInputState(state, { text: '文', type: 'composition-update' })

    expect(shouldCommitCompositionEnd(state, state.compositionText)).toBe(true)

    state = transitionEditorInputState(state, { text: '文', type: 'composition-pending' })
    state = transitionEditorInputState(state, { type: 'transaction-committed' })

    expect(shouldCommitCompositionEnd(state, '文')).toBe(false)

    state = transitionEditorInputState(state, { type: 'composition-end' })

    expect(state).toMatchObject({
      compositionActive: false,
      compositionCommitted: false,
      compositionText: '',
      phase: 'idle',
    })
  })

  it('owns DOM selection reconciliation decisions', () => {
    let state = createEditorInputState()

    expect(
      shouldSyncSessionSelectionFromDom(state, {
        hiddenInputFocused: false,
      }),
    ).toBe(true)
    expect(selectionBeforeEditSource(state, { hiddenInputFocused: false })).toBe('dom')

    state = transitionEditorInputState(state, { type: 'selection-owned-by-session' })

    expect(shouldSyncCustomSelectionFromDom(state, { hiddenInputFocused: false })).toBe(false)
    expect(selectionBeforeEditSource(state, { hiddenInputFocused: false })).toBe('session')

    state = transitionEditorInputState(state, { type: 'selection-owned-by-dom' })
    state = transitionEditorInputState(state, { type: 'mouse-selection-start' })

    expect(shouldSyncSessionSelectionFromDom(state, { hiddenInputFocused: false })).toBe(false)
    expect(selectionBeforeEditSource(state, { hiddenInputFocused: true })).toBe('hidden-input')

    state = transitionEditorInputState(state, { type: 'mouse-selection-finish' })

    expect(shouldSyncSessionSelectionFromDom(state, { hiddenInputFocused: false })).toBe(true)
  })
})
