import type {
  EditorDisposable,
  EditorFeatureContribution,
  EditorFeatureContributionContext,
  EditorPlugin,
  EditorResolvedSelection,
} from '@editor/core/extensions'
import type { EditorFindOptions } from './types'
import {
  EditorFindController,
  type EditorFindResolvedSelection,
  type EditorFindSelectionRange,
} from './findController'

export const EDITOR_FIND_FEATURE_ID = 'editor.find'

export type EditorFindFeature = {
  openFind(): boolean
  toggleFind(): boolean
  openFindReplace(): boolean
  closeFind(): boolean
  findNext(): boolean
  findPrevious(): boolean
  replaceOne(): boolean
  replaceAll(): boolean
  selectAllMatches(): boolean
}

export function createEditorFindPlugin(options: EditorFindOptions = {}): EditorPlugin {
  return {
    name: 'editor.find',
    activate(context) {
      return context.registerEditorFeatureContribution({
        createContribution: (contributionContext) =>
          createFindContribution(contributionContext, options),
      })
    },
  }
}

function createFindContribution(
  context: EditorFeatureContributionContext,
  options: EditorFindOptions,
): EditorFeatureContribution {
  const controller = new EditorFindController(
    {
      container: context.container,
      scrollElement: context.scrollElement,
      hasDocument: () => context.hasDocument(),
      getText: () => context.getText(),
      getSelections: () => findSelections(context.getSelections()),
      focusEditor: () => context.focusEditor(),
      setSelection: (anchor, head, timingName, revealOffset) =>
        context.setSelection(anchor, head, timingName, revealOffset),
      setSelections: (selections, timingName, revealOffset) =>
        context.setSelections(selections, timingName, revealOffset),
      applyEdits: (edits, timingName, selection) =>
        context.applyEdits(edits, timingName, selection),
      setRangeHighlight: (name, ranges, style) => context.setRangeHighlight(name, ranges, style),
      clearRangeHighlight: (name) => context.clearRangeHighlight(name),
    },
    context.highlightPrefix,
    options,
  )
  const disposables = registerFindFeature(context, controller)

  return {
    handleEditorChange: (change) => controller.handleEditorChange(change),
    dispose() {
      disposeAll(disposables)
      controller.dispose()
    },
  }
}

function registerFindFeature(
  context: EditorFeatureContributionContext,
  controller: EditorFindController,
): readonly EditorDisposable[] {
  const feature = createFindFeature(controller)

  return [
    context.registerFeature<EditorFindFeature>(EDITOR_FIND_FEATURE_ID, feature),
    context.registerCommand('find', () => controller.toggleFind()),
    context.registerCommand('findReplace', () => controller.openFindReplace()),
    context.registerCommand('findNext', () => controller.findNext()),
    context.registerCommand('findPrevious', () => controller.findPrevious()),
    context.registerCommand('closeFind', () => controller.close()),
    context.registerCommand('toggleFindCaseSensitive', () => controller.toggleMatchCase()),
    context.registerCommand('toggleFindWholeWord', () => controller.toggleWholeWord()),
    context.registerCommand('toggleFindRegex', () => controller.toggleRegex()),
    context.registerCommand('toggleFindInSelection', () => controller.toggleFindInSelection()),
    context.registerCommand('togglePreserveCase', () => controller.togglePreserveCase()),
    context.registerCommand('replaceOne', () => controller.replaceOne()),
    context.registerCommand('replaceAll', () => controller.replaceAll()),
    context.registerCommand('selectAllMatches', () => controller.selectAllMatches()),
  ]
}

function createFindFeature(controller: EditorFindController): EditorFindFeature {
  return {
    openFind: () => controller.openFind(),
    toggleFind: () => controller.toggleFind(),
    openFindReplace: () => controller.openFindReplace(),
    closeFind: () => controller.close(),
    findNext: () => controller.findNext(),
    findPrevious: () => controller.findPrevious(),
    replaceOne: () => controller.replaceOne(),
    replaceAll: () => controller.replaceAll(),
    selectAllMatches: () => controller.selectAllMatches(),
  }
}

function findSelections(
  selections: readonly EditorResolvedSelection[],
): readonly EditorFindResolvedSelection[] {
  return selections.map((selection) => ({
    ...selection,
    collapsed: selection.startOffset === selection.endOffset,
  }))
}

function disposeAll(disposables: readonly EditorDisposable[]): void {
  for (const disposable of disposables.toReversed()) disposable.dispose()
}

export type { EditorFindOptions, EditorFindSelectionRange }
