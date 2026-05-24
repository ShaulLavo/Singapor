export interface EditorTokenStyle {
  color?: string
  backgroundColor?: string
  fontStyle?: 'normal' | 'italic'
  fontWeight?: string | number
  textDecoration?: string
}

export interface EditorToken {
  start: number
  end: number
  style: EditorTokenStyle
}

export interface TextEdit {
  from: number
  to: number
  text: string
}

export interface EditorDocument {
  text: string
  tokens?: readonly EditorToken[]
}
