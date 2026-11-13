import { describe, expect, it } from 'vitest'
import { scanBash, scanPwsh, scanCommand } from '../src/scanner.ts'

describe('scanBash', () => {
  it('splits compound commands into subcommands', () => {
    const r = scanBash('git status && rm -rf src')
    expect(r).toEqual({ ok: true, subcommands: ['git status', 'rm -rf src'] })
  })

  it('splits pipes, semicolons, newlines, and ||', () => {
    expect(scanBash('cat a | grep x | head')).toEqual({ ok: true, subcommands: ['cat a', 'grep x', 'head'] })
    expect(scanBash('ls; echo done')).toEqual({ ok: true, subcommands: ['ls', 'echo done'] })
    expect(scanBash('git diff\nls -la')).toEqual({ ok: true, subcommands: ['git diff', 'ls -la'] })
    expect(scanBash('foo || bar')).toEqual({ ok: true, subcommands: ['foo', 'bar'] })
  })

  it('does not split inside quotes', () => {
    const r = scanBash(`echo "a && b" && ls`)
    expect(r).toEqual({ ok: true, subcommands: [`echo "a && b"`, 'ls'] })
    expect(scanBash(`echo 'a | b'`)).toEqual({ ok: true, subcommands: [`echo 'a | b'`] })
  })

  it('ignores split operators inside heredoc bodies', () => {
    const cmd = `python - <<'PY'\nopen("a","w").write("x") && echo hi\nPY\necho after`
    const r = scanBash(cmd)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.subcommands.some((s) => s.startsWith('python'))).toBe(true)
  })

  it('fails closed on dynamic evaluation', () => {
    expect(scanBash('$CMD arg').ok).toBe(false)
    expect(scanBash('`touch x`').ok).toBe(false)
    expect(scanBash('echo ${HOME}/x && ls').ok).toBe(false)
    expect(scanBash('echo "$(cmd)"').ok).toBe(false)
    // Inside single quotes it is inert.
    expect(scanBash("grep '$(x)' file").ok).toBe(true)
  })

  it('fails closed on unbalanced quotes and unterminated heredocs', () => {
    expect(scanBash(`echo "unterminated`).ok).toBe(false)
    expect(scanBash(`echo 'unterminated`).ok).toBe(false)
    expect(scanBash("cat <<'EOF'\nno terminator").ok).toBe(false)
  })

  it('keeps simple redirections analyzable (the write heuristic sees them)', () => {
    const r = scanBash('echo hi > out.txt')
    expect(r).toEqual({ ok: true, subcommands: ['echo hi > out.txt'] })
  })
})

describe('scanPwsh', () => {
  it('splits on ; and |', () => {
    expect(scanPwsh('Get-Process; Set-Content a b')).toEqual({ ok: true, subcommands: ['Get-Process', 'Set-Content a b'] })
    expect(scanPwsh('Get-ChildItem | Select Name')).toEqual({ ok: true, subcommands: ['Get-ChildItem', 'Select Name'] })
  })

  it('fails closed on subexpressions and escapes', () => {
    expect(scanPwsh('Write-Output $(whoami)').ok).toBe(false)
    expect(scanPwsh('Write-Output "n`ntest"').ok).toBe(false)
    expect(scanPwsh("Write-Output 'literal $(x)'").ok).toBe(true)
  })

  it('fails closed on unbalanced quotes', () => {
    expect(scanPwsh('Write-Output "oops').ok).toBe(false)
  })
})

describe('scanCommand', () => {
  it('dispatches by shell', () => {
    expect(scanCommand('bash', 'a && b')).toEqual({ ok: true, subcommands: ['a', 'b'] })
    expect(scanCommand('pwsh', 'a; b')).toEqual({ ok: true, subcommands: ['a', 'b'] })
  })
})
