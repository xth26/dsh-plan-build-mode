/**
 * Host half of `dsh-plan-build-mode`.
 *
 * Implements an OpenCode-style Plan / Build mode with a tool permission gate:
 *
 * - `/plan-build`             -> Toggle between Plan and Build modes
 * - `/plan-build status`      -> Show the current mode
 * - `/plan-build switch plan`  -> Plan mode (read-only by policy)
 * - `/plan-build switch build` -> Build mode (writable)
 * - `/permission status|allow|deny` -> Inspect / adjust the permission gate
 * - Denies write-category tools while in Plan mode (OpenCode `edit` permission)
 * - Permits reads outside the workspace (DSH reads pass through every mode);
 *   external writes stay gated by the sandbox unless `external_directory` is
 *   configured to `ask`
 * - Injects a `plan-build:policy` system prompt section
 *
 * Mode state lives in the plugin-owned `plan-build/mode` session event; the
 * `sandbox/mode` event is still written for sandbox enforcement whenever the
 * target sandbox actually differs.
 *
 * @module dsh-plan-build-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import z from '@deepseek-ai/schemastery'
// Side-effect type imports: pull in Cordis module augmentations for ctx.*.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  currentPlanBuildMode,
  currentSandboxMode,
  DEFAULT_BUILD_SANDBOX,
  DEFAULT_PLAN_SANDBOX,
  isPlanModeActive,
  setPlanBuildMode,
} from './helpers.ts'
import type { PlanBuildMode } from './helpers.ts'
import {
  approvalDenyReason,
  canonicalize,
  categoryDenyReason,
  categoryOf,
  DEFAULT_ACTIONS,
  DEFAULT_EXTERNAL_DEFAULT,
  DEFAULT_PERMISSION,
  DEFAULT_PLAN_OVERRIDES,
  extractCommand,
  extractTargets,
  externalDenyReason,
  externalWriteEscalationReason,
  gateDecision,
  matchSubjectsFor,
  noApprovalChannelReason,
  planWriteDenyReason,
  resolveCategory,
  resolveTarget,
  sandboxAllowsWrite,
} from './permissions.ts'
import type { Decision, PermissionValue, ResolvedCategory, ToolCategory } from './permissions.ts'
import type { PlanBuildModeConfig } from './types.ts'

/** Cordis plugin name. */
export const name = 'dsh-plan-build-mode'
/**
 * Service dependencies for the host half. `commands` is injected optionally at
 * runtime via ctx.inject(['commands'], ...) so headless assemblies stay
 * unaffected; `approval` is read optionally via ctx.get('approval').
 */
export const inject = ['tools', 'systemPrompt'] as const

const PERMISSION_ACTIONS = z.union([z.const('allow'), z.const('ask'), z.const('deny')])
const PERMISSION_VALUE = z.union([PERMISSION_ACTIONS, z.dict(PERMISSION_ACTIONS)])
const CATEGORY_MAP = z.dict(PERMISSION_VALUE)
const SANDBOX = z.union([z.const('read-only'), z.const('workspace-write'), z.const('danger-full-access')])

/** Configuration schema. */
export const Config = z.object({
  planSandbox: SANDBOX.required(false),
  buildSandbox: SANDBOX.required(false),
  denyWriteTools: z.boolean().default(true),
  section: z.boolean().default(true),
  plansDirectory: z.string().default('.opencode/plans'),
  permission: CATEGORY_MAP.required(false),
  externalDirectory: z.object({
    default: PERMISSION_ACTIONS.required(false),
    rules: z.array(z.object({ pattern: z.string(), action: PERMISSION_ACTIONS })).required(false),
  }).required(false),
  modes: z.object({
    plan: CATEGORY_MAP.required(false),
    build: CATEGORY_MAP.required(false),
  }).required(false),
}) as unknown as z

/**
 * Plugin entry point.
 * @param ctx - Cordis context carrying the injected services.
 * @param config - Validated deployment configuration.
 */
export function apply(ctx: Context, config: PlanBuildModeConfig = {}): void {
  const planSandbox = config.planSandbox ?? DEFAULT_PLAN_SANDBOX
  const buildSandbox = config.buildSandbox ?? DEFAULT_BUILD_SANDBOX
  const denyWriteTools = config.denyWriteTools !== false
  const enableSection = config.section !== false
  const plansDirectory = config.plansDirectory ?? '.opencode/plans'

  // Session-scoped external-path allowlist (OpenCode "always", in-memory).
  const allowlist = new Map<string, string[]>()

  const executionConfig: ExecutionConfig = {
    planSandbox,
    buildSandbox,
    denyWriteTools,
    plansDirectory,
    permission: config.permission,
    externalDirectory: config.externalDirectory,
    modes: config.modes,
  }

  ctx.effect(() => {
    const disposers: (() => void)[] = []

    // Inject a system prompt section describing the current mode.
    if (enableSection) {
      disposers.push(ctx.systemPrompt.section({
        name: 'plan-build:policy',
        order: 56,
        text(context: AssembleContext) {
          const agent = (context as { agent?: { session: Session } }).agent
          if (agent === undefined) return ''
          return isPlanModeActive(agent.session, planSandbox)
            ? 'You are in OpenCode Plan Mode. You are READ-ONLY: you may not modify files except under the configured plans directory. You may read files anywhere (including outside the workspace), search code, browse directories, ask questions, and inspect data or run quick read-only sanity checks. You are encouraged to write short command-line Python snippets (for example, python -B -c "...") to read data files, compute statistics, sample records, or run fast tests that do not modify the filesystem or write caches. Avoid commands that install packages, write files, generate build artifacts, or change the system. If a verification requires writing files, leave it for Build Mode. Present a complete plan and use /plan-build (or /plan-build switch build) to enter Build Mode before implementing. In Plan Mode you may write plan files only under the configured plans directory.'
            : 'You are in OpenCode Build Mode. You may edit files, run commands, and execute the approved plan. Make minimal changes, run tests/verification after changes, and ask for confirmation before destructive git operations or system-wide changes. Run /plan-build (or /plan-build switch plan) to return to Plan Mode when you need to re-plan. Reading files outside the session workspace is allowed; writing outside the workspace requires sandbox escalation (retry with sandbox_permissions + justification).'
        },
      }))
    }

    // The tool permission gate (OpenCode `permission` + `external_directory`).
    disposers.push(ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      const decision = await evaluateExecution(exec, executionConfig, allowlist, ctx)
      if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
      return next()
    }))

    // Pin a deterministic mode event on new sessions (and legacy-loaded ones)
    // so mode state does not depend on sandbox inference forever.
    const pinMode = (session: Session): void => {
      if (currentPlanBuildMode(session, planSandbox) !== undefined) return
      const sandbox = currentSandboxMode(session)
      let inferred: PlanBuildMode
      if (sandbox === undefined) {
        inferred = 'build'
      } else if (planSandbox !== buildSandbox) {
        inferred = sandbox === planSandbox ? 'plan' : 'build'
      } else {
        inferred = sandbox === 'read-only' ? 'plan' : 'build'
      }
      session.append('plan-build/mode', { mode: inferred })
    }
    disposers.push(ctx.on('session/created', pinMode))
    const sessions = (ctx as { sessions?: { list(): Session[] } }).sessions
    if (sessions !== undefined) {
      for (const session of sessions.list()) pinMode(session)
    }

    // Drop session-scoped allowlist entries when their session is disposed.
    disposers.push(ctx.on('session/disposed', (session: Session) => {
      allowlist.delete(session.id)
    }))

    // User-facing slash commands: mode toggle + permission gate control.
    ctx.inject(['commands'], (commandCtx) => {
      disposers.push(commandCtx.commands.register({
        name: 'plan-build',
        description: 'Toggle between OpenCode Plan and Build modes',
        input: { hint: '[status | switch [plan|build]]' },
        handler: ({ agent, rawInput }: CommandInvocation): CommandResult => {
          const arg = rawInput.trim().toLowerCase()
          const active = isPlanModeActive(agent.session, planSandbox)

          if (arg === '' || arg === 'switch') {
            const next = active ? 'build' : 'plan'
            setPlanBuildMode(agent, next, planSandbox, buildSandbox)
            return {
              kind: 'success',
              text: `Switched to ${next} mode. Run /plan-build again to switch back.`,
            }
          }

          if (arg === 'status') {
            return {
              kind: 'success',
              text: active
                ? 'Plan mode is active (read-only by policy). Run /plan-build to enter Build mode, or /plan-build switch build.'
                : 'Build mode is active. Run /plan-build to enter Plan mode, or /plan-build switch plan.',
            }
          }

          if (!arg.startsWith('switch')) {
            return {
              kind: 'error',
              text: 'Usage: /plan-build (toggle), /plan-build status, or /plan-build switch [plan|build].',
            }
          }

          const target = arg.slice('switch'.length).trim().toLowerCase()
          if (target !== 'plan' && target !== 'build') {
            return {
              kind: 'error',
              text: 'Usage: /plan-build switch plan, or /plan-build switch build.',
            }
          }

          const targetActive = target === 'plan'
          if (active === targetActive) {
            return { kind: 'success', text: `Already in ${target} mode.` }
          }

          setPlanBuildMode(agent, target, planSandbox, buildSandbox)
          return { kind: 'success', text: `Switched to ${target} mode.` }
        },
      }))

      disposers.push(commandCtx.commands.register({
        name: 'permission',
        description: 'Inspect or adjust the OpenCode-style permission gate (external-path allowlist)',
        input: { hint: '[status | allow <pattern> | deny <pattern>]' },
        handler: ({ agent, rawInput }: CommandInvocation): CommandResult => {
          const arg = rawInput.trim()
          const sessionId = agent.session.id
          const entries = allowlist.get(sessionId) ?? []

          if (arg === '' || arg === 'status') {
            const rules = (config.externalDirectory?.rules ?? []).map((r) => `${r.pattern}=${r.action}`).join(', ')
            return {
              kind: 'success',
              text: [
                'Permission gate status:',
                `- external_directory default: ${config.externalDirectory?.default ?? DEFAULT_EXTERNAL_DEFAULT}`,
                `- external_directory rules: ${rules || '(none)'}`,
                `- session allowlist: ${entries.join(', ') || '(empty)'}`,
              ].join('\n'),
            }
          }

          const parts = arg.split(/\s+/)
          const verb = parts[0] ?? ''
          const pattern = parts.slice(1).join(' ')
          if (verb === 'allow' && pattern !== '') {
            if (!entries.includes(pattern)) {
              entries.push(pattern)
              allowlist.set(sessionId, entries)
            }
            return { kind: 'success', text: `Allowed external path pattern for this session: ${pattern}` }
          }
          if (verb === 'deny' && pattern !== '') {
            allowlist.set(sessionId, entries.filter((p) => p !== pattern))
            return { kind: 'success', text: `Removed external path pattern from this session's allowlist: ${pattern}` }
          }
          return { kind: 'error', text: 'Usage: /permission status, /permission allow <pattern>, or /permission deny <pattern>.' }
        },
      }))
    })

    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}

/** Resolved runtime inputs for one execution's evaluation. */
interface ExecutionConfig {
  planSandbox: SandboxMode
  buildSandbox: SandboxMode
  denyWriteTools: boolean
  plansDirectory: string
  permission?: PlanBuildModeConfig['permission']
  externalDirectory?: PlanBuildModeConfig['externalDirectory']
  modes?: PlanBuildModeConfig['modes']
}

/** The plugin's view of the effective category policy for a mode. */
function categorySpecFor(
  config: ExecutionConfig,
  mode: 'plan' | 'build',
  category: ToolCategory,
): ResolvedCategory {
  const globalValue: PermissionValue = config.permission?.[category] ?? DEFAULT_PERMISSION[category]
  const modeValue: PermissionValue | undefined = mode === 'plan'
    ? (config.modes?.plan?.[category] ?? (category === 'edit' && !config.denyWriteTools ? 'allow' : DEFAULT_PLAN_OVERRIDES[category]))
    : config.modes?.build?.[category]
  return resolveCategory(modeValue ?? globalValue, DEFAULT_ACTIONS[category])
}

interface ApprovalLike {
  request(req: {
    agent: unknown
    toolName: string
    callId: string
    reason: string
    signal: AbortSignal
  }): Promise<string>
}

/** Evaluate one tool call through the permission gate; pure decision + approval. */
async function evaluateExecution(
  exec: ToolExecution,
  config: ExecutionConfig,
  allowlist: Map<string, string[]>,
  ctx: Context,
): Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string }> {
  if (exec.agent === undefined) return { kind: 'allow' }
  const session = exec.agent.session
  const mode: PlanBuildMode = currentPlanBuildMode(session, config.planSandbox) ?? 'build'
  const workspaceRoot = canonicalize(session.header.cwd ?? process.cwd())
  const plansDir = canonicalize(resolveTarget(config.plansDirectory, workspaceRoot))
  const category = categoryOf(exec.name)
  const targets = extractTargets(exec.name, exec.arguments).map((t) => canonicalize(resolveTarget(t, workspaceRoot)))
  const command = extractCommand(exec.name, exec.arguments)
  const matchSubjects = matchSubjectsFor(exec.name, targets, workspaceRoot, command)
  const effectiveSandbox = currentSandboxMode(session)

  const decision: Decision = gateDecision({
    mode,
    category,
    targets,
    matchSubjects,
    workspaceRoot,
    plansDir,
    allowlist: allowlist.get(session.id) ?? [],
    externalDefault: config.externalDirectory?.default ?? DEFAULT_EXTERNAL_DEFAULT,
    externalRules: config.externalDirectory?.rules,
    categorySpec: category === undefined ? { action: 'allow' } : categorySpecFor(config, mode, category),
    sandboxAllowsWrite: (target) => sandboxAllowsWrite(effectiveSandbox, target, workspaceRoot),
  })

  if (decision.kind === 'allow') return { kind: 'allow' }
  if (decision.kind === 'deny') return { kind: 'deny', reason: denialReason(exec.name, mode, category, decision) }

  // ask → approval channel (fail closed on any resolution problem).
  const approval = (ctx as { get?: (name: string) => unknown }).get?.('approval') as ApprovalLike | undefined
  if (approval === undefined) return { kind: 'deny', reason: noApprovalChannelReason(exec.name) }
  let outcome: string
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: `permission gate: ${exec.name} requires approval under the configured permission`,
      signal: exec.signal,
    })
  } catch {
    return { kind: 'deny', reason: `Tool '${exec.name}' requires approval, but the approval request failed closed.` }
  }
  if (outcome !== 'allowed-once') return { kind: 'deny', reason: approvalDenyReason(exec.name, outcome) }
  return { kind: 'allow' }
}

/** Map a gate decision onto a model-facing reason string. */
function denialReason(
  toolName: string,
  mode: 'plan' | 'build',
  category: ToolCategory | undefined,
  decision: Extract<Decision, { kind: 'deny' }>,
): string {
  if (decision.code === 'plan-write' || (mode === 'plan' && category === 'edit' && decision.code === 'category-deny')) {
    return planWriteDenyReason(toolName)
  }
  if (decision.code === 'external-deny') return externalDenyReason(toolName, decision.target ?? '')
  if (decision.code === 'external-write-escalation') return externalWriteEscalationReason(toolName, decision.target ?? '')
  return categoryDenyReason(toolName, decision.subject)
}
