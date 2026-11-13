/**
 * Minimal shell command scanner for `dsh-plan-build-mode` Plan mode.
 *
 * Approximates OpenCode's portable shell scanner semantics without pulling a
 * parser dependency:
 *
 * - Splits a command into subcommands on `&&`, `||`, `;`, `|`, `&` and
 *   newlines — quote- and heredoc-aware — so a write cannot hide behind a
 *   read prefix (`git status && rm -rf src`).
 * - Fail closed: unbalanced quoting, unterminated heredocs, or dynamic
 *   evaluation (`$(...)`, backticks, `${...}` parameter expansion feeding
 *   bash) produce a scanner error instead of an allow.
 * - Each subcommand is then checked by the existing write heuristics.
 *
 * PowerShell: `$(` / backtick-escaping / `&` call operators are treated as
 * dynamic-structure; splitting covers `;`, `|`, newlines, and statement
 * separators. This is deliberately stricter than the shell itself — plan
 * mode should under-allow, not over-allow.
 *
 * @module dsh-plan-build-mode/scanner
 */

/** Result of scanning one command text. */
export type ScanResult =
  | { ok: true; subcommands: string[] }
  | { ok: false; error: string }

/** Strip one quoted section (single or double quote) from an index onward. */
function findQuoteEnd(line: string, start: number, quote: string): number {
  let i = start + 1
  if (quote === '"') {
    while (i < line.length) {
      if (line[i] === '\\' && i + 1 < line.length) { i += 2; continue }
      if (line[i] === '"') return i
      i++
    }
    return -1
  }
  while (i < line.length) {
    if (line[i] === quote) return i
    i++
  }
  return -1
}

/**
 * Whether bash dynamic-evaluation constructs appear outside quotes:
 * command substitution `$(...)` / `` `...` `` and parameter expansion
 * `${...}`. `$VAR` alone stays allowed (read-only env expansion is common in
 * genuine read commands like `git log $BRANCH`); only structures that can
 * change WHAT runs are fail-closed.
 */
function hasBashDynamicConstructs(command: string): boolean {
  const line = command
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\'' ) {
      const end = findQuoteEnd(line, i, '\'')
      if (end === -1) return false
      i = end + 1
      continue
    }
    if (ch === '"') {
      const end = findQuoteEnd(line, i, '"')
      if (end === -1) return false
      // Inside double quotes `$(...)` and backticks still evaluate.
      const inner = line.slice(i + 1, end)
      if (/\$\(|`/.test(inner)) return true
      i = end + 1
      continue
    }
    if (ch === '\\') { i += 2; continue }
    if (ch === '`') return true
    if (ch === '$' && line[i + 1] === '(') return true
    // Parameter expansion `${…}` and bare `$VAR` both change WHAT runs when
    // the expansion sits in command position; plan mode cannot know, so any
    // unquoted `$` expansion fails closed. Single-quoted `$` is inert.
    if (ch === '$' && line[i + 1] !== undefined && !/[\s]/.test(line[i + 1]!)) return true
    i++
  }
  return false
}

/** PowerShell dynamic-structure signals (fail closed in plan mode). */
function hasPwshDynamicConstructs(command: string): boolean {
  const line = command
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\'') {
      const end = findQuoteEnd(line, i, '\'')
      if (end === -1) return false
      i = end + 1
      continue
    }
    if (ch === '"') {
      const end = findQuoteEnd(line, i, '"')
      if (end === -1) return false
      // PowerShell double quotes expand `$var` / `$(...)` / backtick escapes.
      const inner = line.slice(i + 1, end)
      if (/\$\(/.test(inner) || /`[n0abfv"`]/.test(inner)) return true
      i = end + 1
      continue
    }
    if (ch === '`') return true // escape / dynamic escape sequence
    if (ch === '$' && line[i + 1] === '(') return true
    if (ch === '&' && line[i + 1] !== '&' && /(^|[\s;|{])&\s*[\w$[{]/.test(line.slice(Math.max(0, i - 1), i + 2) + line.slice(i + 2, i + 3))) return true
    i++
  }
  return false
}

/**
 * Split a command into subcommands. Splits on top-level `&&`, `||`, `;`,
 * `|`, `&` and newlines — never inside quotes or heredoc bodies. Returns
 * trimmed, non-empty segments.
 */
function splitSubcommands(command: string): string[] | undefined {
  const segments: string[] = []
  let current = ''
  let i = 0
  let heredocTag: string | undefined

  const push = (): void => {
    const t = current.trim()
    if (t !== '') segments.push(t)
    current = ''
  }

  while (i < command.length) {
    // Heredoc body: after `<<[-]?TAG` everything until the terminator line is
    // opaque data. The tag itself was already captured by the write
    // heuristics; here we skip the body so split operators inside it are
    // ignored.
    if (heredocTag !== undefined) {
      const rest = command.slice(i)
      const lineEnd = rest.indexOf('\n')
      const line = lineEnd === -1 ? rest : rest.slice(0, lineEnd)
      if (line.trim() === heredocTag) {
        heredocTag = undefined
        i += lineEnd === -1 ? rest.length : lineEnd + 1
        continue
      }
      // Body line: append so the segment's write heuristics see interpreter
      // idioms (open(..., "w"), write_text, etc.) inside heredoc-fed scripts.
      current += '\n' + line
      i += lineEnd === -1 ? rest.length : lineEnd + 1
      continue
    }
    const ch = command[i]
    if (ch === '\'' || ch === '"') {
      const end = findQuoteEnd(command, i, ch)
      if (end === -1) return undefined // unbalanced quote → scanner error
      current += command.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === '\n' || ch === ';') {
      push()
      i++
      continue
    }
    if (ch === '|' || ch === '&') {
      if (command[i + 1] === ch) {
        push()
        i += 2
        continue
      }
      if (ch === '|') {
        push()
        i++
        continue
      }
      // Single `&` (background): statement separator for our purposes only
      // when followed by more command text.
      const rest = command.slice(i + 1).trim()
      if (rest !== '' && !rest.startsWith('&')) {
        push()
        i++
        continue
      }
      current += ch
      i++
      continue
    }
    // Heredoc start: capture the tag (optionally quoted: <<'EOF' <<\"EOF\") and
    // switch to body-skipping.
    const heredoc = /^<<(-?)(['\"`]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(command.slice(i))
    if (heredoc !== null) {
      heredocTag = heredoc[3]
      current += command.slice(i, i + heredoc[0].length)
      i += heredoc[0].length
      // Tag captured: the body follows on the NEXT line and is opaque data —
      // but the write heuristics must still see interpreter idioms inside it
      // (`python - <<'PY'\nopen(...,"w")…`). Keep the body text in the
      // current segment so per-subcommand write checks cover it.
      continue
    }
    current += ch
    i++
  }
  if (heredocTag !== undefined) return undefined // unterminated heredoc
  push()
  return segments
}

/**
 * Scan one bash command: fail closed on unbalanced quoting, unterminated
 * heredocs or dynamic-evaluation constructs; otherwise return subcommands.
 */
export function scanBash(command: string): ScanResult {
  if (hasBashDynamicConstructs(command)) {
    return { ok: false, error: 'dynamic evaluation ($(…), backtick, or ${…} expansion)' }
  }
  const segments = splitSubcommands(command)
  if (segments === undefined) return { ok: false, error: 'unbalanced quoting or unterminated heredoc' }
  return { ok: true, subcommands: segments }
}

/**
 * Scan one PowerShell command: fail closed on subexpressions and escape
 * sequences; split on `;`, `|`, statement newlines.
 */
export function scanPwsh(command: string): ScanResult {
  if (hasPwshDynamicConstructs(command)) {
    return { ok: false, error: 'dynamic evaluation ($(...) subexpression or escape sequence)' }
  }
  const segments = splitSubcommands(command)
  if (segments === undefined) return { ok: false, error: 'unbalanced quoting' }
  return { ok: true, subcommands: segments }
}

/** Dispatch by tool shell kind. */
export function scanCommand(shell: 'bash' | 'pwsh', command: string): ScanResult {
  return shell === 'bash' ? scanBash(command) : scanPwsh(command)
}
