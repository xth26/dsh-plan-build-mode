/**
 * OpenCode-style tool permission engine for `dsh-plan-build-mode`.
 *
 * Models OpenCode's `permission` system — allow | ask | deny per tool
 * category, object-syntax rules with last-match-wins, `~`/`$HOME` expansion,
 * and the `external_directory` gate that asks for any path outside the
 * session workspace — as pure, testable functions evaluated by the plugin's
 * `tools/pre-execute` hook.
 *
 * The DSH sandbox stays the hard enforcement floor: a permission grant can
 * never widen what the sandbox permits, and the gate only ever `ask`s for
 * targets the sandbox can actually allow (the single-prompt principle — an
 * external write the sandbox rejects goes straight to the existing
 * sandbox-escalation flow instead of asking here first).
 *
 * @module dsh-plan-build-mode/permissions
 */

import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

/** One of OpenCode's permission verdicts. */
export type PermissionAction = 'allow' | 'ask' | 'deny'

/** Tool categories the permission engine gates (mirrors OpenCode's permission keys). */
export type ToolCategory = 'read' | 'edit' | 'glob' | 'grep' | 'bash' | 'pwsh' | 'webfetch' | 'websearch'

/** A wildcard permission rule: pattern → action. */
export interface PermissionRule {
  pattern: string
  action: PermissionAction
}

/** Scalar value, or object-syntax rules (`{ pattern: action, ... }`, last-match-wins). */
export type PermissionValue = PermissionAction | Record<string, PermissionAction>

/** The `external_directory` gate config: default action + explicit rules. */
export interface ExternalDirectoryConfig {
  default?: PermissionAction
  rules?: PermissionRule[]
}

/** Per-mode permission overrides, applied over the global `permission`. */
export interface ModePermissionConfig {
  plan?: Partial<Record<ToolCategory, PermissionValue>>
  build?: Partial<Record<ToolCategory, PermissionValue>>
}

/** Scalar default action per category (the fallback when no value is given). */
export const DEFAULT_ACTIONS: Record<ToolCategory, PermissionAction> = {
  read: 'allow',
  edit: 'allow',
  glob: 'allow',
  grep: 'allow',
  bash: 'allow',
  pwsh: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
}

/** Global default actions, mirroring OpenCode (most allow; `.env*` reads denied). */
export const DEFAULT_PERMISSION: Record<ToolCategory, PermissionValue> = {
  read: { '*': 'allow', '**/.env': 'deny', '**/.env.*': 'deny', '**/.env.example': 'allow' },
  edit: DEFAULT_ACTIONS.edit,
  glob: DEFAULT_ACTIONS.glob,
  grep: DEFAULT_ACTIONS.grep,
  bash: DEFAULT_ACTIONS.bash,
  pwsh: DEFAULT_ACTIONS.pwsh,
  webfetch: DEFAULT_ACTIONS.webfetch,
  websearch: DEFAULT_ACTIONS.websearch,
}

/** Default Plan-mode overrides (write tools denied, commands ask). */
export const DEFAULT_PLAN_OVERRIDES: Partial<Record<ToolCategory, PermissionValue>> = {
  edit: 'deny',
  bash: 'ask',
  pwsh: 'ask',
}

/**
 * Default `external_directory` action. Reads of files outside the workspace
 * stay permitted (DSH reads pass through every sandbox mode); only writes are
 * gated. Set to `'ask'` for full OpenCode behavior (external access prompts).
 */
export const DEFAULT_EXTERNAL_DEFAULT: PermissionAction = 'allow'

/** Tools gated under the `read` category. */
const READ_TOOLS = ['read', 'read_image', 'pdf_read', 'docx_read', 'pptx_read', 'xlsx_read'] as const
/** Tools gated under the `edit` category (OpenCode: `write` is controlled by `edit`). */
const WRITE_TOOLS = [
  'write',
  'edit',
  'pdf_create',
  'docx_create',
  'pptx_create',
  'xlsx_write',
  'pptx_edit',
  'xlsx_edit',
] as const

/** Path argument keys per tool name (verified against the DSH tool schemas). */
const TOOL_PATH_KEYS: Record<string, readonly string[]> = {
  read: ['file_path'],
  read_image: ['file_path'],
  pdf_read: ['file_path'],
  docx_read: ['file_path'],
  pptx_read: ['file_path'],
  xlsx_read: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  pptx_edit: ['file_path'],
  xlsx_edit: ['file_path'],
  pdf_create: ['destination_path'],
  docx_create: ['destination_path'],
  pptx_create: ['destination_path'],
  xlsx_write: ['file_path'],
  glob: ['path'],
  grep: ['path'],
}

/** Map a tool name to its permission category, or undefined for ungated tools. */
export function categoryOf(name: string): ToolCategory | undefined {
  if ((READ_TOOLS as readonly string[]).includes(name)) return 'read'
  if ((WRITE_TOOLS as readonly string[]).includes(name)) return 'edit'
  switch (name) {
    case 'glob':
      return 'glob'
    case 'grep':
      return 'grep'
    case 'bash':
      return 'bash'
    case 'pwsh':
      return 'pwsh'
    case 'web_fetch':
      return 'webfetch'
    case 'web_search':
      return 'websearch'
    default:
      return undefined
  }
}

/** The static directory prefix of a glob pattern (`src/**\/*.ts` → `src`). */
function patternBaseDir(pattern: string): string | undefined {
  const firstWild = pattern.search(/[*?]/)
  const head = firstWild === -1 ? pattern : pattern.slice(0, firstWild)
  const idx = head.lastIndexOf('/')
  if (idx <= 0) return undefined
  return head.slice(0, idx)
}

/**
 * Extract the model-controlled path targets from one tool call's parsed
 * arguments. Unknown or malformed arguments yield no targets: the category
 * gate still applies, and the sandbox remains the floor for writes.
 */
export function extractTargets(name: string, args: unknown): string[] {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return []
  const record = args as Record<string, unknown>
  const targets: string[] = []
  const keys = TOOL_PATH_KEYS[name]
  if (keys !== undefined) {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') targets.push(value)
    }
  }
  if (name === 'glob' || name === 'grep') {
    const pattern = record.pattern
    if (typeof pattern === 'string' && pattern.trim() !== '') {
      const base = patternBaseDir(pattern)
      if (base !== undefined && base !== '') targets.push(base)
    }
  }
  return targets
}

/** Extract the raw command text for bash/pwsh tools (used for prefix rules). */
export function extractCommand(name: string, args: unknown): string | undefined {
  if (name !== 'bash' && name !== 'pwsh') return undefined
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>).command
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Normalize a path/pattern for cross-platform wildcard matching (forward slashes). */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Expand `~` / `$HOME` at the start of a pattern to the user home directory. */
export function expandHome(pattern: string, home: string): string {
  if (pattern === '~') return normalizePath(home)
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) return normalizePath(home + pattern.slice(1))
  if (pattern.startsWith('$HOME')) return normalizePath(home + pattern.slice('$HOME'.length))
  return normalizePath(pattern)
}

/** OpenCode wildcard match: `*` = any run, `?` = one char, everything else literal. */
export function wildcardMatch(pattern: string, value: string): boolean {
  let re = ''
  for (const ch of pattern) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(value)
}

/** Matching options for rule evaluation. */
export interface RuleMatchContext {
  /** User home for `~` expansion (defaults to `os.homedir()`). */
  home?: string
  /** Whether comparisons ignore case — Windows paths. */
  caseSensitive?: boolean
}

/** Whether one permission pattern matches a value under the match context. */
export function ruleMatches(pattern: string, value: string, ctx: RuleMatchContext = {}): boolean {
  const home = ctx.home ?? homedir()
  const cs = ctx.caseSensitive ?? true
  const p = expandHome(pattern, home)
  const v = normalizePath(value)
  return wildcardMatch(cs ? p : p.toLowerCase(), cs ? v : v.toLowerCase())
}

/**
 * Evaluate an ordered rule list against any of several subjects, last matching
 * rule wins (OpenCode's evaluation order). Returns undefined when nothing matches.
 */
export function matchRules(
  rules: readonly PermissionRule[] | undefined,
  subjects: readonly string[],
  ctx: RuleMatchContext = {},
): PermissionAction | undefined {
  if (rules === undefined || rules.length === 0 || subjects.length === 0) return undefined
  let hit: PermissionAction | undefined
  for (const subject of subjects) {
    for (const rule of rules) {
      if (ruleMatches(rule.pattern, subject, ctx)) hit = rule.action
    }
  }
  return hit
}

/** A category's resolved policy: a scalar action plus optional object-form rules. */
export interface ResolvedCategory {
  action: PermissionAction
  rules?: readonly PermissionRule[]
}

/**
 * Normalize a `PermissionValue` into a scalar action plus ordered rules. The
 * object form's `*` key becomes the catch-all default; later matching
 * non-`*` rules override it (last-match-wins).
 */
export function resolveCategory(value: PermissionValue | undefined, fallback: PermissionAction): ResolvedCategory {
  if (value === undefined) return { action: fallback }
  if (typeof value === 'string') return { action: value }
  const rules: PermissionRule[] = []
  let action = fallback
  for (const [pattern, ruleAction] of Object.entries(value)) {
    if (pattern === '*') {
      action = ruleAction
    } else {
      rules.push({ pattern, action: ruleAction })
    }
  }
  return rules.length > 0 ? { action, rules } : { action }
}

/** Canonicalize a path (resolve symlinks of the deepest existing ancestor). */
export function canonicalize(path: string): string {
  return canonicalPath(path)
}

/** Resolve a model-provided path against the session working directory. */
export function resolveTarget(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

/** Whether `target` is `root` or lies beneath it (lexical, canonical spellings). */
export function isUnder(target: string, root: string, caseSensitive: boolean): boolean {
  const t = normalizePath(target)
  const r = normalizePath(root)
  if (t === r) return true
  const prefix = r.endsWith('/') ? r : `${r}/`
  const a = caseSensitive ? t : t.toLowerCase()
  const b = caseSensitive ? prefix : prefix.toLowerCase()
  return a.startsWith(b)
}

/** Host filesystem case sensitivity (Windows paths compare case-insensitively). */
export function caseSensitiveHost(): boolean {
  return process.platform !== 'win32'
}

/**
 * Whether the effective sandbox mode would permit a WRITE to the given
 * canonical target — the single-prompt principle: the gate only asks for
 * writes the sandbox can actually allow.
 */
export function sandboxAllowsWrite(
  mode: SandboxMode | undefined,
  target: string,
  workspaceRoot: string,
  tempRoots: readonly string[] = ['/tmp', tmpdir()],
): boolean {
  if (mode === 'danger-full-access') return true
  if (mode === 'workspace-write') {
    const cs = caseSensitiveHost()
    return [workspaceRoot, ...tempRoots].some((root) => isUnder(target, canonicalize(root), cs))
  }
  return false
}

/** Subjects category rules are matched against: relative and absolute forms. */
export function matchSubjectsFor(
  name: string,
  targets: readonly string[],
  workspaceRoot: string,
  command: string | undefined,
): string[] {
  if (name === 'bash' || name === 'pwsh') {
    return command === undefined ? [] : [command]
  }
  const first = targets[0]
  if (first === undefined) return []
  return [normalizePath(relative(workspaceRoot, first)), normalizePath(first)]
}

/** The resolved verdict of {@link gateDecision}. */
export type Decision =
  | { kind: 'allow' }
  | { kind: 'ask' }
  | {
      kind: 'deny'
      code: 'plan-write' | 'external-deny' | 'external-write-escalation' | 'category-deny'
      /** The offending external target, when the denial is external. */
      target?: string | undefined
      /** The matched subject, when the denial comes from a category rule. */
      subject?: string | undefined
    }

/** Pure inputs for the gate's decision procedure. */
export interface GateInput {
  mode: 'plan' | 'build'
  category: ToolCategory | undefined
  /** Canonical absolute targets (resolved + canonicalized). */
  targets: readonly string[]
  /** Subjects matched against category rules. */
  matchSubjects: readonly string[]
  /** Canonical workspace root. */
  workspaceRoot: string
  /** Canonical plans directory (`workspaceRoot`/`plansDirectory`). */
  plansDir: string
  /** Session-scoped allowlist patterns (OpenCode "always"). */
  allowlist: readonly string[]
  /** `external_directory` default action. */
  externalDefault: PermissionAction
  /** `external_directory` explicit rules (last-match-wins). */
  externalRules: readonly PermissionRule[] | undefined
  /** The category's resolved policy. */
  categorySpec: ResolvedCategory
  /** Per-target sandbox write allowance. */
  sandboxAllowsWrite: (target: string) => boolean
}

/**
 * Pure decision procedure. Order: plans-dir carve-out → external-directory
 * gate → category gate. `ask` is only returned when an approval channel can
 * resolve it; writes the sandbox cannot permit never ask (single-prompt
 * principle — they surface as a `external-write-escalation` denial instead).
 */
export function gateDecision(input: GateInput): Decision {
  const { mode, category, targets, workspaceRoot, plansDir } = input
  const cs = caseSensitiveHost()

  // 1. Plan-mode plans-directory carve-out (OpenCode `.opencode/plans/`).
  if (
    mode === 'plan' &&
    category === 'edit' &&
    targets.length > 0 &&
    targets.every((t) => isUnder(t, plansDir, cs))
  ) {
    return { kind: 'allow' }
  }

  // 2. External-directory gate.
  const external = targets.filter((t) => !isUnder(t, workspaceRoot, cs))
  if (external.length > 0) {
    const context = { caseSensitive: cs }
    const subject = external[0]!
    if (input.allowlist.some((pattern) => ruleMatches(pattern, subject, context))) return { kind: 'allow' }
    const action = matchRules(input.externalRules, external, context) ?? input.externalDefault
    if (action === 'deny') return { kind: 'deny', code: 'external-deny', target: subject }
    if (action === 'ask') {
      if (category === 'edit' && !external.every((t) => input.sandboxAllowsWrite(t))) {
        return { kind: 'deny', code: 'external-write-escalation', target: subject }
      }
      return { kind: 'ask' }
    }
    // allow → fall through to the category gate.
  }

  // 3. Category gate.
  if (category === undefined) return { kind: 'allow' }
  const categoryContext = { caseSensitive: cs }
  const subject = input.matchSubjects[0]
  const action =
    matchRules(input.categorySpec.rules, input.matchSubjects, categoryContext) ?? input.categorySpec.action
  if (action === 'deny') return { kind: 'deny', code: 'category-deny', subject }
  if (action === 'ask') {
    if (category === 'edit' && targets.length > 0 && !targets.every((t) => input.sandboxAllowsWrite(t))) {
      return { kind: 'deny', code: 'external-write-escalation', target: targets[0] }
    }
    return { kind: 'ask' }
  }
  return { kind: 'allow' }
}

/** Denial wording: Plan-mode write (keeps the historical `forbidden in Plan Mode` phrase). */
export function planWriteDenyReason(toolName: string): string {
  return `Tool '${toolName}' is forbidden in Plan Mode (write permission denied). Only files under the configured plans directory may be written in Plan Mode; run /plan-build (or /plan-build switch build) to leave Plan Mode before editing elsewhere.`
}

/** Denial wording: an explicit external-directory deny rule matched. */
export function externalDenyReason(toolName: string, target: string): string {
  return `external path access denied for '${target}' (${toolName}) under the external-directory permission. Use /permission allow <pattern> to allowlist this path for the current session, or configure externalDirectory.rules.`
}

/** Denial wording: a write the sandbox cannot permit (single-prompt handoff). */
export function externalWriteEscalationReason(toolName: string, target: string): string {
  return `writing outside the workspace ('${target}') is not permitted by the current sandbox (${toolName}). Retry this ${toolName} call once with sandbox_permissions + justification to request approval, or configure buildSandbox: danger-full-access for full write control.`
}

/** Denial wording: a category rule denied the call. */
export function categoryDenyReason(toolName: string, subject: string | undefined): string {
  const what = subject === undefined || subject === '' ? '' : ` for '${subject}'`
  return `Tool '${toolName}' is denied by the configured permission${what}. Adjust the permission config, or use /permission allow <pattern> to allowlist this path.`
}

/** Denial wording: the approval channel rejected/aborted the ask. */
export function approvalDenyReason(toolName: string, outcome: string): string {
  return `Tool '${toolName}' requires approval and the request was ${outcome}.`
}

/** Denial wording: no approval channel is composed to resolve an ask. */
export function noApprovalChannelReason(toolName: string): string {
  return `Tool '${toolName}' requires approval, but no approval channel is composed.`
}
