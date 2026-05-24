export const EDITOR_FIND_FEATURE_ID = 'editor.find'

export type EditorFindFeature = {
  openFind(): boolean
  openFindReplace(): boolean
  closeFind(): boolean
  findNext(): boolean
  findPrevious(): boolean
  replaceOne(): boolean
  replaceAll(): boolean
  selectAllMatches(): boolean
}
