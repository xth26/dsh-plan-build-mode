/**
 * Browser half of `dsh-plan-build-mode`.
 *
 * Adds a global keyboard shortcut that toggles OpenCode Plan / Build mode by
 * executing the host `/plan-build` command against the current session. The
 * bundle is a pure listener: it renders nothing and occupies no Slot seat.
 *
 * The services are consumed through locally declared structural faces rather
 * than cross-plugin imports on purpose — a browser bundle must not compile a
 * require() edge into the loader module table (bundle purity), and these
 * shapes are small and stable. The default combo is kept deliberately complex
 * (three modifiers) so it collides with no terminal or browser built-in.
 *
 * @module dsh-plan-build-mode/client
 */

/** Default shortcut; keep in sync with DEFAULT_SHORTCUT in ../helpers.ts. */
export const DEFAULT_SHORTCUT = 'ctrl+alt+shift+p'

/** Client plugin name. */
export const name = 'plan-build-mode-client'

/**
 * Services required at runtime: the commands Remote for `/plan-build` and the
 * session list for the current session id.
 */
export const inject = ['remote', 'remote.commands', 'sessions'] as const

/** Optional config subset accepted by the client bundle. */
export interface PlanBuildModeClientConfig {
  /** One or more `ctrl+alt+shift+p` style combos; defaults to DEFAULT_SHORTCUT. */
  readonly shortcut?: string | readonly string[]
}

/** Minimal structural faces of the services this plugin consumes. */
export interface PlanBuildModeClientContext {
  effect(fn: () => (() => void) | void): void
  sessions: {
    list: {
      getSnapshot(): { current: string | undefined }
    }
  }
  remote: {
    commands: {
      execute(sessionId: string, line: string, images: readonly unknown[]): Promise<{
        ok: boolean
        error?: { code: string; message: string }
      }>
    }
  }
}

/** A parsed `ctrl+alt+shift+p` style combo. */
export interface ParsedShortcut {
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly key: string
}

/**
 * Parse a `ctrl+alt+shift+p` style combo. Requires at least one of ctrl/alt
 * and exactly one key; returns undefined for malformed or modifier-less
 * combos (mirrors the dsh-tui combo grammar).
 */
export function parseShortcutCombo(raw: string): ParsedShortcut | undefined {
  const parts = String(raw ?? '')
    .toLowerCase()
    .split('+')
    .map(part => part.trim())
    .filter(part => part !== '')
  if (parts.length < 2) return undefined
  let ctrl = false
  let alt = false
  let shift = false
  let key: string | undefined
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') {
      ctrl = true
    } else if (part === 'alt' || part === 'meta' || part === 'option') {
      alt = true
    } else if (part === 'shift') {
      shift = true
    } else if (part === 'space') {
      if (key !== undefined) return undefined
      key = ' '
    } else if ([...part].length === 1) {
      if (key !== undefined) return undefined
      key = part
    } else {
      return undefined
    }
  }
  if (key === undefined) return undefined
  if (!ctrl && !alt) return undefined
  return { ctrl, alt, shift, key }
}

/** Structural keydown shape so matching is testable without a DOM. */
export interface ShortcutKeyEvent {
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly key: string
}

/** Exact modifier + key match against a keydown event. The mac cmd (meta)
 *  modifier is never part of a spelled combo, so any meta press is a miss. */
export function shortcutMatches(combo: ParsedShortcut, event: ShortcutKeyEvent): boolean {
  if (event.metaKey) return false
  if (event.ctrlKey !== combo.ctrl) return false
  if (event.altKey !== combo.alt) return false
  if (event.shiftKey !== combo.shift) return false
  return event.key.toLowerCase() === combo.key
}

/** Resolve configured combos to parsed form, dropping malformed entries. */
export function resolveCombos(configured: string | readonly string[] | undefined): ParsedShortcut[] {
  const raw = configured === undefined
    ? [DEFAULT_SHORTCUT]
    : typeof configured === 'string'
      ? [configured]
      : [...configured]
  return raw
    .map(parseShortcutCombo)
    .filter((combo): combo is ParsedShortcut => combo !== undefined)
}

/**
 * Client plugin body: one global keydown listener that runs `/plan-build`
 * against the current session. Inert without a current session, during IME
 * composition, and on non-matching combos.
 * @param ctx - client root context.
 * @param config - optional config subset (shortcut combos).
 */
export function apply(ctx: PlanBuildModeClientContext, config: PlanBuildModeClientConfig = {}): void {
  const combos = resolveCombos(config.shortcut)
  if (combos.length === 0) return
  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      for (const combo of combos) {
        if (!shortcutMatches(combo, event)) continue
        const sessionId = ctx.sessions.list.getSnapshot().current
        if (sessionId === undefined) return
        event.preventDefault()
        void ctx.remote.commands.execute(sessionId, '/plan-build', []).then((result) => {
          if (!result.ok && result.error !== undefined) {
            console.warn(`[plan-build-mode] shortcut failed (${result.error.code}): ${result.error.message}`)
          }
        })
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  })
}
