import { describe, expect, it } from 'vitest'

import '../src/style.css'

describe('find widget styles', () => {
  it('keeps the replace row hidden when collapsed', () => {
    const row = document.createElement('div')
    row.className = 'editor-find-row editor-find-replace-row'
    row.hidden = true
    document.body.appendChild(row)

    expect(getComputedStyle(row).display).toBe('none')

    row.hidden = false
    expect(getComputedStyle(row).display).toBe('flex')
    row.remove()
  })

  it('uses inherited editor theme colors', () => {
    const host = document.createElement('div')
    const widget = document.createElement('div')
    host.style.setProperty('--editor-background', 'rgb(250, 250, 250)')
    host.style.setProperty('--editor-foreground', 'rgb(15, 23, 42)')
    widget.className = 'editor-find-widget'
    host.append(widget)
    document.body.append(host)

    expect(getComputedStyle(widget).color).toBe('rgb(15, 23, 42)')
    host.remove()
  })
})
