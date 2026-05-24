import { describe, expect, it } from 'vitest'

import { createTopBar } from '../../src/components/topBar.ts'

describe('createTopBar', () => {
  it('tracks repository status', () => {
    const topBar = createTopBar()

    topBar.setRepositoryName('ShaulLavo/singapor')
    expect(topBar.element.querySelector('#dir-name')?.textContent).toBe('ShaulLavo/singapor')

    topBar.setBusyState(true)
    expect(topBar.element.querySelectorAll('button')).toHaveLength(4)

    topBar.setMessage('Failed')
    expect(topBar.element.querySelector('#dir-name')?.textContent).toBe('Failed')
  })

  it('updates view and diff controls', () => {
    const topBar = createTopBar()
    const buttons = topBar.element.querySelectorAll('button')

    topBar.setViewMode('diff')
    topBar.setDiffMode('stacked')

    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[2]?.hidden).toBe(false)
    expect(buttons[3]?.getAttribute('aria-pressed')).toBe('true')
  })
})
