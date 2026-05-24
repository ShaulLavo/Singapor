import type { TextEdit } from '../tokens'

export function syncTextEdit(current: string, next: string): TextEdit {
  const prefixLength = commonPrefixLength(current, next)
  const suffixLength = commonSuffixLength(current, next, prefixLength)
  const currentEnd = current.length - suffixLength
  const nextEnd = next.length - suffixLength

  return {
    from: prefixLength,
    to: currentEnd,
    text: next.slice(prefixLength, nextEnd),
  }
}

function commonPrefixLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length)
  let length = 0
  while (length < maxLength && left.charCodeAt(length) === right.charCodeAt(length)) {
    length += 1
  }

  return length
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const maxLength = Math.min(left.length, right.length) - prefixLength
  let length = 0
  while (length < maxLength) {
    const leftIndex = left.length - length - 1
    const rightIndex = right.length - length - 1
    if (left.charCodeAt(leftIndex) !== right.charCodeAt(rightIndex)) break

    length += 1
  }

  return length
}
