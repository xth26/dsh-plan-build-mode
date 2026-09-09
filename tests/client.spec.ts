import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHORTCUT,
  parseShortcutCombo,
  resolveCombos,
  shortcutMatches,
  type ParsedShortcut,
  type ShortcutKeyEvent,
} from '../src/client/index.ts'

function key(partial: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    key: 'p',
    ...partial,
  }
}

describe('parseShortcutCombo', () => {
  it('parses the default triple-modifier combo', () => {
    expect(parseShortcutCombo(DEFAULT_SHORTCUT)).toEqual({
      ctrl: true,
      alt: true,
      shift: true,
      key: 'p',
    })
  })

  it('parses a two-modifier combo', () => {
    expect(parseShortcutCombo('alt+p')).toEqual({ ctrl: false, alt: true, shift: false, key: 'p' })
  })

  it('parses a space combo', () => {
    expect(parseShortcutCombo('ctrl+space')).toEqual({ ctrl: true, alt: false, shift: false, key: ' ' })
  })

  it('accepts modifier aliases', () => {
    expect(parseShortcutCombo('control+option+p')).toEqual({ ctrl: true, alt: true, shift: false, key: 'p' })
  })

  it('rejects a combo without ctrl or alt', () => {
    expect(parseShortcutCombo('shift+p')).toBeUndefined()
    expect(parseShortcutCombo('p')).toBeUndefined()
  })

  it('rejects combos with more than one key or empty parts', () => {
    expect(parseShortcutCombo('ctrl+alt+p+x')).toBeUndefined()
    expect(parseShortcutCombo('ctrl+')).toBeUndefined()
    expect(parseShortcutCombo('')).toBeUndefined()
  })
})

describe('shortcutMatches', () => {
  it('matches the exact combo', () => {
    const combo = parseShortcutCombo(DEFAULT_SHORTCUT)!
    expect(shortcutMatches(combo, key({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true)
  })

  it('misses on a missing modifier', () => {
    const combo = parseShortcutCombo(DEFAULT_SHORTCUT)!
    expect(shortcutMatches(combo, key({ ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('misses when the meta (cmd) key is held', () => {
    const combo = parseShortcutCombo(DEFAULT_SHORTCUT)!
    expect(shortcutMatches(combo, key({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }))).toBe(false)
  })

  it('misses on a different key', () => {
    const combo = parseShortcutCombo(DEFAULT_SHORTCUT)!
    expect(shortcutMatches(combo, key({ ctrlKey: true, altKey: true, shiftKey: true, key: 'o' }))).toBe(false)
  })
})

describe('resolveCombos', () => {
  it('defaults to DEFAULT_SHORTCUT', () => {
    const combos = resolveCombos(undefined)
    expect(combos).toEqual([parseShortcutCombo(DEFAULT_SHORTCUT)])
  })

  it('accepts a single string', () => {
    const combos = resolveCombos('alt+p')
    expect(combos.map((c: ParsedShortcut) => c.key)).toEqual(['p'])
    expect(combos[0]!.alt).toBe(true)
  })

  it('accepts an array and drops malformed entries', () => {
    const combos = resolveCombos(['alt+p', 'bogus', 'ctrl+shift+k'])
    expect(combos.map((c: ParsedShortcut) => c.key)).toEqual(['p', 'k'])
  })
})
