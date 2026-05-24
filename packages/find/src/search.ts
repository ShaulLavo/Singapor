export const FIND_MATCHES_LIMIT = 19_999

export type FindRange = {
  readonly start: number
  readonly end: number
}

export type FindQuery = {
  readonly searchString: string
  readonly isRegex: boolean
  readonly matchCase: boolean
  readonly wholeWord: boolean
}

export type FindMatch = FindRange & {
  readonly matches: readonly string[] | null
}

type CompiledFindQuery = {
  readonly regex: RegExp
  readonly simpleSearch: string | null
  readonly simpleNeedle: string | null
  readonly wholeWord: boolean
}

export function findMatches(
  text: string,
  query: FindQuery,
  ranges: readonly FindRange[] | null = null,
  captureMatches = false,
  limit = FIND_MATCHES_LIMIT,
): readonly FindMatch[] {
  const compiled = compileFindQuery(query)
  if (!compiled) return []

  const searchRanges = normalizedSearchRanges(text, ranges)
  const matches: FindMatch[] = []
  for (const range of searchRanges) {
    appendMatchesInRange(matches, text, compiled, range, captureMatches, limit)
    if (matches.length >= limit) break
  }

  return matches
}

export function nextMatchAfter(
  matches: readonly FindMatch[],
  offset: number,
  loop: boolean,
): FindMatch | null {
  if (matches.length === 0) return null

  const next = matches.find((match) => match.start >= offset)
  if (next) return next
  return loop ? (matches[0] ?? null) : null
}

export function previousMatchBefore(
  matches: readonly FindMatch[],
  offset: number,
  loop: boolean,
): FindMatch | null {
  if (matches.length === 0) return null

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!
    if (match.end <= offset) return match
  }

  return loop ? (matches.at(-1) ?? null) : null
}

export function findMatchIndex(matches: readonly FindMatch[], range: FindRange): number {
  return matches.findIndex((match) => match.start === range.start && match.end === range.end)
}

export function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&')
}

function compileFindQuery(query: FindQuery): CompiledFindQuery | null {
  if (query.searchString.length === 0) return null

  const source = query.isRegex ? query.searchString : escapeRegExpCharacters(query.searchString)
  const flags = query.matchCase ? 'gmu' : 'gimu'

  try {
    return {
      regex: new RegExp(source, flags),
      simpleSearch: query.isRegex ? null : query.searchString,
      simpleNeedle: query.matchCase ? query.searchString : query.searchString.toLocaleLowerCase(),
      wholeWord: query.wholeWord,
    }
  } catch {
    return null
  }
}

function normalizedSearchRanges(
  text: string,
  ranges: readonly FindRange[] | null,
): readonly FindRange[] {
  if (!ranges || ranges.length === 0) return [{ start: 0, end: text.length }]

  return ranges
    .map((range) => ({
      start: clamp(range.start, 0, text.length),
      end: clamp(range.end, 0, text.length),
    }))
    .filter((range) => range.start <= range.end)
    .toSorted((left, right) => left.start - right.start || left.end - right.end)
}

function appendMatchesInRange(
  matches: FindMatch[],
  text: string,
  query: CompiledFindQuery,
  range: FindRange,
  captureMatches: boolean,
  limit: number,
): void {
  if (query.simpleSearch && !captureMatches) {
    appendSimpleMatches(matches, text, query, range, limit)
    return
  }

  appendRegexMatches(matches, text, query, range, captureMatches, limit)
}

function appendSimpleMatches(
  matches: FindMatch[],
  text: string,
  query: CompiledFindQuery,
  range: FindRange,
  limit: number,
): void {
  const needle = query.simpleNeedle
  const searchString = query.simpleSearch
  if (!needle || !searchString) return

  const haystack = query.regex.ignoreCase ? text.toLocaleLowerCase() : text
  let index = range.start - searchString.length
  while (matches.length < limit) {
    index = haystack.indexOf(needle, index + searchString.length)
    if (index === -1 || index + searchString.length > range.end) return
    if (index < range.start) continue
    if (!validWholeWordMatch(text, index, searchString.length, query.wholeWord)) continue

    matches.push({ start: index, end: index + searchString.length, matches: null })
  }
}

function appendRegexMatches(
  matches: FindMatch[],
  text: string,
  query: CompiledFindQuery,
  range: FindRange,
  captureMatches: boolean,
  limit: number,
): void {
  query.regex.lastIndex = range.start
  while (matches.length < limit) {
    const match = query.regex.exec(text)
    if (!match) return

    if (!appendRegexMatch(matches, text, query, range, match, captureMatches)) return
    if (match[0].length === 0) advancePastEmptyMatch(query.regex, text)
  }
}

function appendRegexMatch(
  matches: FindMatch[],
  text: string,
  query: CompiledFindQuery,
  range: FindRange,
  match: RegExpExecArray,
  captureMatches: boolean,
): boolean {
  const start = match.index
  const end = start + match[0].length
  if (start > range.end) return false
  if (end > range.end) return false
  if (!validWholeWordMatch(text, start, match[0].length, query.wholeWord)) return true

  matches.push({
    start,
    end,
    matches: captureMatches ? match : null,
  })
  return true
}

function advancePastEmptyMatch(regex: RegExp, text: string): void {
  const current = regex.lastIndex
  if (current > text.length) return

  const size = codePointSizeAt(text, current)
  regex.lastIndex = current + Math.max(1, size)
}

function validWholeWordMatch(
  text: string,
  start: number,
  length: number,
  wholeWord: boolean,
): boolean {
  if (!wholeWord) return true
  return leftIsWordBoundary(text, start, length) && rightIsWordBoundary(text, start, length)
}

function leftIsWordBoundary(text: string, start: number, length: number): boolean {
  if (start === 0) return true
  if (!isWordCodePointBefore(text, start)) return true
  if (length === 0) return false
  return !isWordCodePointAt(text, start)
}

function rightIsWordBoundary(text: string, start: number, length: number): boolean {
  const end = start + length
  if (end === text.length) return true
  if (!isWordCodePointAt(text, end)) return true
  if (length === 0) return false
  return !isWordCodePointBefore(text, end)
}

function isWordCodePointBefore(text: string, offset: number): boolean {
  if (offset <= 0) return false

  const previous = previousCodePointStart(text, offset)
  return previous !== null && isWordCodePointAt(text, previous)
}

function isWordCodePointAt(text: string, offset: number): boolean {
  const codePoint = text.codePointAt(offset)
  if (codePoint === undefined) return false
  return /^[\p{L}\p{N}_]$/u.test(String.fromCodePoint(codePoint))
}

function previousCodePointStart(text: string, offset: number): number | null {
  if (offset <= 0) return null

  const previous = offset - 1
  const codeUnit = text.charCodeAt(previous)
  const beforePrevious = previous - 1
  const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff
  if (!isLowSurrogate || beforePrevious < 0) return previous

  const previousCodeUnit = text.charCodeAt(beforePrevious)
  const isHighSurrogate = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff
  return isHighSurrogate ? beforePrevious : previous
}

function codePointSizeAt(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset)
  if (codePoint === undefined) return 0
  return codePoint > 0xffff ? 2 : 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
