/**
 * Host half of `dsh-plan-build-mode`.
 *
 * Implements an OpenCode-style Plan / Build mode with a tool permission gate:
 *
 * - `/plan-build`             -> Toggle between Plan and Build modes
 * - `/plan-build status`      -> Show the current mode
 * - `/plan-build switch plan`  -> Plan mode (read-only by policy)
 * - `/plan-build switch build` -> Build mode (writable)
 * - `/oc-permission status|allow|deny` -> Inspect / adjust the permission gate
 * - Denies write-category tools while in Plan mode (OpenCode `edit` permission)
 * - Permits reads outside the workspace (DSH reads pass through every mode);
 *   external writes stay gated by the sandbox unless `external_directory` is
 *   configured to `ask`
 * - Injects a `plan-build:policy` system prompt section
 *
 * Mode state lives in the plugin-owned `storageDomain` KV domain (in-memory
 * fallback when no backend is mounted); the `sandbox/mode` override is written
 * through the official `setSandboxMode()` API whenever the target sandbox
 * actually differs.
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
import { SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_BUILD_SANDBOX,
  DEFAULT_PLAN_SANDBOX,
  setPlanBuildMode,
} from './helpers.ts'
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
import { openModeStore } from './store.ts'
import type { ModeStore } from './store.ts'
import type { PlanBuildMode, PlanBuildModeConfig } from './types.ts'

/** Cordis plugin name. */
export const name = 'dsh-plan-build-mode'
/**
 * Service dependencies for the host half. `commands`, `storageDomain`, and
 * `sandboxPolicy` are optional: without them the plugin degrades to the
 * in-memory mode store and pure gate enforcement, so headless assemblies and
 * minimal profiles stay unaffected.
 */
export const inject = ['tools', 'systemPrompt'] as const

const PERMISSION_ACTIONS = z.union([z.const('allow'), z.const('ask'), z.const('deny')])
const PERMISSION_VALUE = z.union([PERMISSION_ACTIONS, z.dict(PERMISSION_ACTIONS)])
const CATEGORY_MAP = z.dict(PERMISSION_VALUE)
const SANDBOX = z.union(SANDBOX_MODES.map((mode) => z.const(mode)))

/** Configuration schema. */
export const Config = z.object({
  planSandbox: SANDBOX.default('workspace-write'),
  buildSandbox: SANDBOX.default('workspace-write'),
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

    // Mode store: domain-backed when storage is mounted, in-memory otherwise.
    // A synchronous in-memory view is active until (and unless) the domain
    // store opens; reads before readiness see Build mode, the fresh default.
    let modeStore: ModeStore = new (class implements ModeStore {
      private readonly records = new Map<string, PlanBuildMode>()
      get(id: string): PlanBuildMode | undefined { return this.records.get(id) }
      set(id: string, mode: PlanBuildMode): void { this.records.set(id, mode) }
      delete(id: string): void { this.records.delete(id) }
      async close(): Promise<void> {}
    })()
    let closeStore: (() => Promise<void>) | undefined
    void openModeStore(ctx as unknown as { get(name: string): unknown }, modeStore).then((store) => {
      modeStore = store
      closeStore = () => store.close()
    }).catch(() => {})

    // Inject a system prompt section describing the current mode.
    if (enableSection) {
      disposers.push(ctx.systemPrompt.section({
        name: 'plan-build:policy',
        order: 56,
        text(context: AssembleContext) {
          const agent = (context as { agent?: { session: Session } }).agent
          if (agent === undefined) return ''
          return modeOf(ctx, agent.session, storeOf(agent, modeStore)) === 'plan'
            ? 'You are in OpenCode Plan Mode. You are READ-ONLY: you may not modify files except under the configured plans directory. You may read files anywhere (including outside the workspace), search code, browse directories, and run commands without confirmation — commands run under the workspace-write sandbox, which is the hard floor: any file or system change outside the plans directory is blocked by the sandbox, not by prompts. Read-only analysis via command-line snippets (for example, python -B -c "...") is encouraged; commands whose purpose is to modify files will fail in the sandbox, so leave them for Build Mode. Present a complete plan and use /plan-build (or /plan-build switch build) to enter Build Mode before implementing. In Plan Mode you may write plan files only under the configured plans directory.'
            : 'You are in OpenCode Build Mode. You may edit files, run commands, and execute the approved plan. Make minimal changes, run tests/verification after changes, and ask for confirmation before destructive git operations or system-wide changes. Run /plan-build (or /plan-build switch plan) to return to Plan Mode when you need to re-plan. Reading files outside the session workspace is allowed; writing outside the workspace requires sandbox escalation (retry with sandbox_permissions + justification).'
        },
      }))
    }

    // The tool permission gate (OpenCode `permission` + `external_directory`).
    disposers.push(ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      const decision = await evaluateExecution(exec, executionConfig, storeOf(exec.agent, modeStore), allowlist, ctx)
      if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
      if (decision.kind === 'ask') {
        return decision.reason === undefined
          ? { kind: 'ask' }
          : { kind: 'ask', reason: decision.reason }
      }
      return next()
    }))

    // Drop session-scoped allowlist entries when their session is disposed.
    disposers.push(ctx.on('session/disposed', (session: Session) => {
      allowlist.delete(session.id)
      modeStore.delete(session.id)
    }))

    // User-facing slash commands: mode toggle + permission gate control.
    // When the official permission-presets service is mounted, mode switches
    // go through `presets.set()` so the stock dropdown, sandbox mode, and
    // approval policy all follow; the plugin-owned store stays the fallback
    // for assemblies without that service.
    const presetsService = (ctx as { get?: (name: string) => unknown }).get?.('permissionPresets') as
      | { current(session: Session): string; set(session: Session, name: string): void }
      | undefined

    /** Switch the session into the given mode through the best write path. */
    const switchMode = (agent: { session: Session }, target: PlanBuildMode): void => {
      if (presetsService !== undefined) {
        presetsService.set(agent.session, target === 'plan' ? PLAN_PRESET : 'oc-build')
        return
      }
      setPlanBuildMode(storeOf(agent, modeStore), agent as never, target, planSandbox, buildSandbox, effectiveSandbox(ctx, agent.session))
    }

    ctx.inject(['commands'], (commandCtx) => {
      disposers.push(commandCtx.commands.register({
        name: 'plan-build',
        description: 'Toggle between OpenCode Plan and Build modes',
        input: { hint: '[status | switch [plan|build]]' },
        handler: ({ agent, rawInput }: CommandInvocation): CommandResult => {
          const arg = rawInput.trim().toLowerCase()
          const active = modeOf(ctx, agent.session, storeOf(agent, modeStore)) === 'plan'

          if (arg === '' || arg === 'switch') {
            const next: PlanBuildMode = active ? 'build' : 'plan'
            switchMode(agent, next)
            return {
              kind: 'success',
              text: `Switched to ${next} mode. Run /plan-build again to switch back.`,
            }
          }

          if (arg === 'status') {
            return {
              kind: 'success',
              text: active
                ? 'Plan mode is active (read-only by policy). Run /plan-build to enter Build mode, /plan-build switch build, or pick any other preset in the permission dropdown.'
                : 'Build mode is active. Run /plan-build to enter Plan mode, /plan-build switch plan, or pick oc-plan in the permission dropdown.',
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

          switchMode(agent, target)
          return { kind: 'success', text: `Switched to ${target} mode.` }
        },
      }))

      disposers.push(commandCtx.commands.register({
        name: 'oc-permission',
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
          return { kind: 'error', text: 'Usage: /oc-permission status, /oc-permission allow <pattern>, or /oc-permission deny <pattern>.' }
        },
      }))
    })

    return () => {
      for (const dispose of disposers) dispose()
      if (closeStore !== undefined) void closeStore()
    }
  })
}

/** Resolve the mode store for one agent: the agent-carried store when the
 * agent's creator attached one, otherwise the plugin's shared store. */
function storeOf(agent: unknown, pluginStore: ModeStore): ModeStore {
  const carried = (agent as { store?: unknown } | undefined)?.store
  return carried !== undefined ? (carried as ModeStore) : pluginStore
}

/** Read the session's effective sandbox override through the policy service. */
function effectiveSandbox(ctx: Context, session: Session): SandboxMode | undefined {
  const policy = (ctx as { get?: (name: string) => unknown }).get?.('sandboxPolicy') as
    | { overrideOf(session: Session): SandboxMode | undefined }
    | undefined
  return policy?.overrideOf(session)
}

/**
 * The plan preset name this plugin contributes to `dsh-permission-presets`.
 * When the session's current permission preset equals this value, the
 * OpenCode-style plan gate is active; any other preset (including the
 * shipped read-only / workspace-write / danger-full-access and oc-build)
 * means Build behavior, so the stock permission dropdown is always the exit.
 */
export const PLAN_PRESET = 'oc-plan'

/** Resolve the effective Plan/Build mode for a session: the official
 * permission preset is authoritative (`oc-plan` = plan); the plugin-owned
 * store is a fallback for assemblies without the permission service. */
function modeOf(ctx: Context, session: Session, modeStore: ModeStore): PlanBuildMode {
  const presets = (ctx as { get?: (name: string) => unknown }).get?.('permissionPresets') as
    | { current(session: Session): string }
    | undefined
  if (presets !== undefined) {
    try {
      return presets.current(session) === PLAN_PRESET ? 'plan' : 'build'
    } catch {
      // Projection key missing (session not yet published): fall through.
    }
  }
  return modeStore.get(session.id) ?? 'build'
}

/** Evaluate one tool call through the permission gate; pure decision + approval. */
async function evaluateExecution(
  exec: ToolExecution,
  config: ExecutionConfig,
  modeStore: ModeStore,
  allowlist: Map<string, string[]>,
  ctx: Context,
): Promise<{ kind: 'allow' } | { kind: 'ask'; reason?: string } | { kind: 'deny'; reason: string }> {
  if (exec.agent === undefined) return { kind: 'allow' }
  const session = exec.agent.session
  const mode: PlanBuildMode = modeOf(ctx, session, modeStore)
  const workspaceRoot = canonicalize(session.header.cwd ?? process.cwd())
  const plansDir = canonicalize(resolveTarget(config.plansDirectory, workspaceRoot))
  const category = categoryOf(exec.name)
  const targets = extractTargets(exec.name, exec.arguments).map((t) => canonicalize(resolveTarget(t, workspaceRoot)))
  const command = extractCommand(exec.name, exec.arguments)
  const matchSubjects = matchSubjectsFor(exec.name, targets, workspaceRoot, command)
  const effectiveSandboxMode = effectiveSandbox(ctx, session)

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
    sandboxAllowsWrite: (target) => sandboxAllowsWrite(effectiveSandboxMode, target, workspaceRoot),
  })

  if (decision.kind === 'allow') return { kind: 'allow' }
  if (decision.kind === 'deny') return { kind: 'deny', reason: denialReason(exec.name, mode, category, decision) }

  // ask �?approval channel (fail closed on any resolution problem).
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
