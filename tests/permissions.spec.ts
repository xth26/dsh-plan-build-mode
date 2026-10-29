import { describe, expect, it } from 'vitest'
import {
  canonicalize,
  caseSensitiveHost,
  categoryOf,
  DEFAULT_ACTIONS,
  DEFAULT_EXTERNAL_DEFAULT,
  DEFAULT_PERMISSION,
  DEFAULT_PLAN_OVERRIDES,
  expandHome,
  extractCommand,
  extractTargets,
  gateDecision,
  isUnder,
  matchRules,
  matchSubjectsFor,
  normalizePath,
  resolveCategory,
  ruleMatches,
  sandboxAllowsWrite,
  wildcardMatch,
} from '../src/permissions.ts'

describe('wildcardMatch', () => {
  it('matches the OpenCode wildcard vocabulary', () => {
    expect(wildcardMatch('*', 'anything')).toBe(true)
    expect(wildcardMatch('src/*.ts', 'src/index.ts')).toBe(true)
    // OpenCode: `*` matches zero or more of ANY character, including `/`.
    expect(wildcardMatch('src/*.ts', 'src/sub/index.ts')).toBe(true)
    expect(wildcardMatch('src/*.ts', 'other/x.ts')).toBe(false)
    expect(wildcardMatch('src/**', 'src/a/b/c.ts')).toBe(true)
    expect(wildcardMatch('foo?bar', 'fooxbar')).toBe(true)
    // OpenCode: `?` matches exactly one of any character, including `/`.
    expect(wildcardMatch('foo?bar', 'foo/bar')).toBe(true)
    expect(wildcardMatch('foo?bar', 'foobar')).toBe(false)
  })

  it('treats regex-special characters as literals', () => {
    expect(wildcardMatch('a.b(c)', 'a.b(c)')).toBe(true)
    expect(wildcardMatch('a.b(c)', 'axb(c)')).toBe(false)
  })
})

describe('expandHome', () => {
  it('expands ~ and $HOME prefixes and normalizes separators', () => {
    expect(expandHome('~/projects/**', 'C:\\Users\\me')).toBe('C:/Users/me/projects/**')
    expect(expandHome('~', 'C:\\Users\\me')).toBe('C:/Users/me')
    expect(expandHome('$HOME/x.txt', 'C:\\Users\\me')).toBe('C:/Users/me/x.txt')
    expect(expandHome('src/**', 'C:\\Users\\me')).toBe('src/**')
  })
})

describe('ruleMatches', () => {
  it('matches with home expansion and optional case sensitivity', () => {
    expect(ruleMatches('~/projects/**', 'C:/Users/me/projects/personal/a.txt', { home: 'C:\\Users\\me', caseSensitive: false })).toBe(true)
    expect(ruleMatches('*.env', 'src/.env', { caseSensitive: false })).toBe(true)
    expect(ruleMatches('src/*.ts', 'SRC/INDEX.TS', { caseSensitive: false })).toBe(true)
    expect(ruleMatches('src/*.ts', 'SRC/INDEX.TS', { caseSensitive: true })).toBe(false)
  })
})

describe('matchRules', () => {
  it('last matching rule wins', () => {
    const rules = [
      { pattern: '**/.env', action: 'deny' as const },
      { pattern: '**/.env.*', action: 'deny' as const },
      { pattern: '**/.env.example', action: 'allow' as const },
    ]
    expect(matchRules(rules, ['src/.env'], { caseSensitive: false })).toBe('deny')
    expect(matchRules(rules, ['src/.env.local'], { caseSensitive: false })).toBe('deny')
    expect(matchRules(rules, ['src/.env.example'], { caseSensitive: false })).toBe('allow')
  })

  it('returns undefined when nothing matches', () => {
    expect(matchRules([{ pattern: 'a/*', action: 'allow' }], ['b/x'], {})).toBeUndefined()
    expect(matchRules(undefined, ['a/x'], {})).toBeUndefined()
  })
})

describe('resolveCategory', () => {
  it('resolves a scalar value', () => {
    expect(resolveCategory('deny', 'allow')).toEqual({ action: 'deny' })
  })

  it('resolves object syntax with a * catch-all and ordered rules', () => {
    const resolved = resolveCategory({ '*': 'allow', '**/.env': 'deny' }, 'ask')
    expect(resolved.action).toBe('allow')
    expect(resolved.rules).toEqual([{ pattern: '**/.env', action: 'deny' }])
  })

  it('uses the fallback when the value is undefined', () => {
    expect(resolveCategory(undefined, 'allow')).toEqual({ action: 'allow' })
  })
})

describe('categoryOf', () => {
  it('maps tools to their categories', () => {
    expect(categoryOf('read')).toBe('read')
    expect(categoryOf('read_image')).toBe('read')
    expect(categoryOf('pdf_read')).toBe('read')
    expect(categoryOf('write')).toBe('edit')
    expect(categoryOf('edit')).toBe('edit')
    expect(categoryOf('pdf_create')).toBe('edit')
    expect(categoryOf('glob')).toBe('glob')
    expect(categoryOf('grep')).toBe('grep')
    expect(categoryOf('bash')).toBe('bash')
    expect(categoryOf('pwsh')).toBe('pwsh')
    expect(categoryOf('web_fetch')).toBe('webfetch')
    expect(categoryOf('web_search')).toBe('websearch')
    expect(categoryOf('skill')).toBeUndefined()
  })
})

describe('extractTargets', () => {
  it('extracts file_path for fs tools', () => {
    expect(extractTargets('read', { file_path: 'src/index.ts' })).toEqual(['src/index.ts'])
    expect(extractTargets('write', { file_path: 'out.txt', content: 'x' })).toEqual(['out.txt'])
  })

  it('extracts destination_path for document generators', () => {
    expect(extractTargets('pdf_create', { destination_path: 'out/a.pdf' })).toEqual(['out/a.pdf'])
    expect(extractTargets('xlsx_write', { file_path: 'out/a.xlsx' })).toEqual(['out/a.xlsx'])
  })

  it('extracts search roots for glob/grep', () => {
    expect(extractTargets('glob', { pattern: 'src/**/*.ts' })).toEqual(['src'])
    expect(extractTargets('grep', { pattern: 'foo', path: 'lib' })).toEqual(['lib'])
    expect(extractTargets('glob', { pattern: '**/*.ts' })).toEqual([])
  })

  it('returns no targets for malformed or ungated arguments', () => {
    expect(extractTargets('read', null)).toEqual([])
    expect(extractTargets('read', {})).toEqual([])
    expect(extractTargets('read', 'nope')).toEqual([])
    expect(extractTargets('skill', { name: 'x' })).toEqual([])
  })
})

describe('extractCommand', () => {
  it('extracts command text for bash/pwsh only', () => {
    expect(extractCommand('bash', { command: 'git status' })).toBe('git status')
    expect(extractCommand('pwsh', { command: 'Get-ChildItem' })).toBe('Get-ChildItem')
    expect(extractCommand('read', { command: 'x' })).toBeUndefined()
    expect(extractCommand('bash', {})).toBeUndefined()
  })
})

describe('isUnder', () => {
  it('is boundary-safe and honors case sensitivity', () => {
    expect(isUnder('C:/ws/src/a.ts', 'C:/ws', true)).toBe(true)
    expect(isUnder('C:/ws', 'C:/ws', true)).toBe(true)
    expect(isUnder('C:/ws2/x', 'C:/ws', true)).toBe(false)
    expect(isUnder('C:/WS/SRC/A.TS', 'c:/ws', false)).toBe(true)
  })
})

describe('matchSubjectsFor', () => {
  it('returns relative and absolute forms for path tools', () => {
    expect(matchSubjectsFor('read', ['C:/ws/src/a.ts'], 'C:/ws', undefined)).toEqual(['src/a.ts', 'C:/ws/src/a.ts'])
  })

  it('returns the command text for command tools', () => {
    expect(matchSubjectsFor('bash', [], 'C:/ws', 'git status')).toEqual(['git status'])
  })
})

describe('sandboxAllowsWrite', () => {
  it('allows everything under danger-full-access', () => {
    expect(sandboxAllowsWrite('danger-full-access', 'C:/anywhere/x', 'C:/ws')).toBe(true)
  })

  it('confines workspace-write to the workspace and temp roots', () => {
    expect(sandboxAllowsWrite('workspace-write', 'C:/ws/a.ts', 'C:/ws', [])).toBe(true)
    expect(sandboxAllowsWrite('workspace-write', 'C:/outside/a.ts', 'C:/ws', [])).toBe(false)
    expect(sandboxAllowsWrite('workspace-write', 'C:/tmp-extra/x', 'C:/ws', ['C:/tmp-extra'])).toBe(true)
  })

  it('denies writes under read-only', () => {
    expect(sandboxAllowsWrite('read-only', 'C:/ws/a.ts', 'C:/ws')).toBe(false)
  })
})

describe('gateDecision', () => {
  const ws = 'C:/ws'
  const plans = `${ws}/.opencode/plans`
  const base = {
    workspaceRoot: ws,
    plansDir: plans,
    allowlist: [],
    externalDefault: DEFAULT_EXTERNAL_DEFAULT,
    categorySpec: { action: 'allow' as const },
    sandboxAllowsWrite: (t: string) => sandboxAllowsWrite('workspace-write', t, ws),
  }

  it('allows writes under the plans directory in Plan mode', () => {
    const d = gateDecision({ ...base, mode: 'plan', category: 'edit', targets: [`${plans}/x.md`], matchSubjects: [] })
    expect(d).toEqual({ kind: 'allow' })
  })

  it('denies non-plans writes in Plan mode (category-deny)', () => {
    const d = gateDecision({
      ...base,
      mode: 'plan',
      category: 'edit',
      targets: [`${ws}/src/index.ts`],
      matchSubjects: ['src/index.ts', `${ws}/src/index.ts`],
      categorySpec: { action: 'deny' },
    })
    expect(d).toMatchObject({ kind: 'deny', code: 'category-deny' })
  })

  it('allows reads everywhere by default (external_directory default allow)', () => {
    const d = gateDecision({
      ...base,
      mode: 'build',
      category: 'read',
      targets: ['C:/outside/sensitive.txt'],
      matchSubjects: ['../outside/sensitive.txt', 'C:/outside/sensitive.txt'],
    })
    expect(d).toEqual({ kind: 'allow' })
  })

  it('denies external access on an explicit deny rule', () => {
    const d = gateDecision({
      ...base,
      mode: 'build',
      category: 'read',
      targets: ['C:/outside/sensitive.txt'],
      matchSubjects: [],
      externalDefault: 'allow',
      externalRules: [{ pattern: 'C:/outside/**', action: 'deny' }],
    })
    expect(d).toMatchObject({ kind: 'deny', code: 'external-deny', target: 'C:/outside/sensitive.txt' })
  })

  it('asks for external reads when external_directory defaults to ask', () => {
    const d = gateDecision({
      ...base,
      mode: 'build',
      category: 'read',
      targets: ['C:/outside/sensitive.txt'],
      matchSubjects: [],
      externalDefault: 'ask',
    })
    expect(d).toEqual({ kind: 'ask' })
  })

  it('never asks for an external write the sandbox cannot permit (escalation handoff)', () => {
    const d = gateDecision({
      ...base,
      mode: 'build',
      category: 'edit',
      targets: ['C:/outside/new.txt'],
      matchSubjects: [],
      externalDefault: 'ask',
      categorySpec: { action: 'allow' },
    })
    expect(d).toMatchObject({ kind: 'deny', code: 'external-write-escalation' })
  })

  it('asks for an external write when the sandbox permits it (danger-full-access)', () => {
    const d = gateDecision({
      ...base,
      mode: 'build',
      category: 'edit',
      targets: ['C:/outside/new.txt'],
      matchSubjects: [],
      externalDefault: 'ask',
      categorySpec: { action: 'allow' },
      sandboxAllowsWrite: () => true,
    })
    expect(d).toEqual({ kind: 'ask' })
  })

  it('honors the session allowlist over the external default', () => {
    const d = gateDecision({
      ...base,
      mode: 'build',
      category: 'read',
      targets: ['C:/outside/x.txt'],
      matchSubjects: [],
      externalDefault: 'ask',
      allowlist: ['C:/outside/**'],
    })
    expect(d).toEqual({ kind: 'allow' })
  })

  it('applies category rules (read .env denied by default)', () => {
    const d = gateDecision({
      ...base,
      mode: 'build',
      category: 'read',
      targets: [`${ws}/src/.env`],
      matchSubjects: ['src/.env', `${ws}/src/.env`],
      categorySpec: resolveCategory(DEFAULT_PERMISSION.read, DEFAULT_ACTIONS.read),
    })
    expect(d).toMatchObject({ kind: 'deny', code: 'category-deny' })
  })

  it('allows ungated categories', () => {
    const d = gateDecision({ ...base, mode: 'build', category: undefined, targets: [], matchSubjects: [] })
    expect(d).toEqual({ kind: 'allow' })
  })

  it('asks when a category is configured to ask', () => {
    const d = gateDecision({
      ...base,
      mode: 'build',
      category: 'read',
      targets: [],
      matchSubjects: ['x'],
      categorySpec: { action: 'ask' },
    })
    expect(d).toEqual({ kind: 'ask' })
  })
})

describe('defaults', () => {
  it('keeps reads outside the workspace permitted by default', () => {
    expect(DEFAULT_EXTERNAL_DEFAULT).toBe('allow')
  })

  it('denies write tools in Plan mode by default and leaves commands to the sandbox', () => {
    expect(DEFAULT_PLAN_OVERRIDES.edit).toBe('deny')
    expect(DEFAULT_PLAN_OVERRIDES.bash).toBeUndefined()
    expect(DEFAULT_PLAN_OVERRIDES.pwsh).toBeUndefined()
  })

  it('exports scalar default actions for every category', () => {
    expect(DEFAULT_ACTIONS.read).toBe('allow')
    expect(DEFAULT_ACTIONS.edit).toBe('allow')
    expect(DEFAULT_ACTIONS.bash).toBe('allow')
  })

  it('normalizes Windows separators to forward slashes', () => {
    expect(normalizePath('C:\\ws\\a.ts')).toBe('C:/ws/a.ts')
  })

  it('canonicalizes a real directory (no throw)', () => {
    expect(canonicalize(process.cwd())).toBeTruthy()
    expect(caseSensitiveHost()).toBeTypeOf('boolean')
  })
})
