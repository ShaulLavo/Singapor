import { describe, expect, it } from 'vitest'
import {
  canWaitForNativeTextInput,
  createEditorInputState,
  editorInputStateOwnership,
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
      type: 'fallback-scheduled',
    })
    state = transitionEditorInputState(state, {
      startMs: 11,
      text: 'B',
      type: 'fallback-appended',
    })

    expect(state).toMatchObject({
      fallbackGeneration: 0,
      fallbackStartMs: 10,
      pendingText: 'AB',
      phase: 'fallback-pending',
    })

    state = transitionEditorInputState(state, { type: 'native-input-observed' })

    expect(state).toMatchObject({
      fallbackGeneration: null,
      nativeInputGeneration: 1,
      nativeTextInputState: 'observed',
      pendingText: '',
      phase: 'native-input-observed',
    })
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
})
