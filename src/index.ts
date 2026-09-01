/**
 * Host half of `dsh-plan-build-mode`.
 *
 * Implements an OpenCode-style Plan / Build mode that is independent from
 * DSH's built-in `/plan` soft-guidance mode:
 *
 * - `/plan-build`             -> Toggle between Plan and Build modes
 * - `/plan-build status`      -> Show the current mode
 * - `/plan-build switch plan`  -> Plan mode + read-only sandbox
 * - `/plan-build switch build` -> Build mode + workspace-write sandbox
 * - Blocks `write`/`edit` tool calls while in Plan mode
 * - Injects a `plan-build:policy` system prompt section
 *
 * @module dsh-plan-build-mode
 */

import type { Context } from '@deepseek-ai/cordis'
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
  DEFAULT_BUILD_SANDBOX,
  DEFAULT_PLAN_SANDBOX,
  isPlanModeActive,
  planModeDenial,
  setPlanBuildMode,
  WRITE_TOOLS,
} from './helpers.ts'
import type { PlanBuildModeConfig } from './types.ts'

/** Cordis plugin name. */
export const name = 'dsh-plan-build-mode'
/** Service dependencies for the host half. */
export const inject = ['agents', 'tools', 'systemPrompt'] as const
/** Configuration schema. */
export const Config = z.object({
  planSandbox: z.union([
    z.const('read-only'),
    z.const('workspace-write'),
    z.const('danger-full-access'),
  ]).required(false),
  buildSandbox: z.union([
    z.const('read-only'),
    z.const('workspace-write'),
    z.const('danger-full-access'),
  ]).required(false),
  denyWriteTools: z.boolean().default(true),
  section: z.boolean().default(true),
  tuiShortcut: z.string().default('ctrl+shift+b'),
})

/**
 * Plugin entry point.
 * @param ctx - Cordis context carrying the injected services.
 * @param config - Validated deployment configuration.
 */
export function apply(ctx: Context, config: PlanBuildModeConfig = {}): void {
  const planSandbox = config.planSandbox ?? DEFAULT_PLAN_SANDBOX
  const buildSandbox = config.buildSandbox ?? DEFAULT_BUILD_SANDBOX
  if (planSandbox === buildSandbox) {
    throw new Error(`planSandbox and buildSandbox must be different, but both are '${planSandbox}'.`)
  }
  const denyWriteTools = config.denyWriteTools !== false
  const enableSection = config.section !== false
  const tuiShortcut = config.tuiShortcut ?? 'ctrl+shift+b'

  ctx.effect(() => {
    const disposers: (() => void)[] = []

    // Align existing sessions on load (resumed sessions may already have
    // sandbox/mode events).
    for (const _agent of ctx.agents.list() as Array<{ session: Session }>) {
      // No-op on load: state is already in the log; we only react to commands.
    }

    // Inject a system prompt section describing the current mode.
    if (enableSection) {
      disposers.push(ctx.systemPrompt.section({
        name: 'plan-build:policy',
        order: 56,
        text(context: AssembleContext) {
          const agent = (context as { agent?: { session: Session } }).agent
          if (agent === undefined) return ''
          return isPlanModeActive(agent.session.events, planSandbox)
            ? 'You are in OpenCode Plan Mode. You are READ-ONLY. You may read files, search code, browse directories, ask questions, and inspect data or run quick read-only sanity checks. You are encouraged to write short command-line Python snippets (for example, python -B -c "...") to read data files, compute statistics, sample records, or run fast tests that do not modify the filesystem or write caches. Avoid commands that install packages, write files, generate build artifacts, or change the system. If a verification requires writing files, leave it for Build Mode. Present a complete plan and use /plan-build (or /plan-build switch build) to enter Build Mode before implementing.'
            : 'You are in OpenCode Build Mode. You may edit files, run commands, and execute the approved plan. Make minimal changes, run tests/verification after changes, and ask for confirmation before destructive git operations or system-wide changes. Run /plan-build (or /plan-build switch plan) to return to Plan Mode when you need to re-plan.'
        },
      }))
    }

    // Block mutating tool calls while in Plan mode.
    disposers.push(ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      if (!denyWriteTools) return next()
      const reason = planModeDenial(exec, planSandbox, WRITE_TOOLS)
      if (reason !== undefined) return { kind: 'deny', reason }
      return next()
    }))

    // User-facing slash command to check or switch Plan/Build mode.
    // Activates only when a command registry is composed (headless assemblies stay unaffected).
    ctx.inject(['commands'], (commandCtx) => {
      disposers.push(commandCtx.commands.register({
        name: 'plan-build',
        description: 'Toggle between OpenCode Plan and Build modes',
        input: { hint: '[status | switch [plan|build]]' },
        handler: ({ agent, rawInput }: CommandInvocation): CommandResult => {
          const arg = rawInput.trim().toLowerCase()
          const active = isPlanModeActive(agent.session.events, planSandbox)

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
                ? 'Plan mode is active (read-only). Run /plan-build to enter Build mode, or /plan-build switch build.'
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
    })

    // TUI-only keyboard shortcut that toggles Plan/Build mode. It is ignored
    // by `dsh web`; it only registers when dsh-tui's shortcut registry is
    // composed, and it skips registration when the configured combo is blank.
    if (tuiShortcut.trim() !== '') {
      const tuiShortcuts = ctx.get('tuiShortcuts') as
        | { register(combo: string, options: { description: string; handler: () => void | Promise<void> }, identity?: unknown): () => void }
        | undefined
      if (tuiShortcuts !== undefined) {
        const disposeShortcut = tuiShortcuts.register(
          tuiShortcut,
          {
            description: 'Toggle OpenCode Plan/Build mode',
            handler() {
              const agent = ctx.agents.currentInitiator()
              if (agent === undefined) return
              const active = isPlanModeActive(agent.session.events, planSandbox)
              const next = active ? 'build' : 'plan'
              setPlanBuildMode(agent, next, planSandbox, buildSandbox)
              // Best-effort echo the same confirmation the slash command shows.
              const commands = ctx.get('commands') as
                | { execute(agent: unknown, line: string, images: readonly unknown[], signal: AbortSignal): Promise<unknown> }
                | undefined
              if (commands !== undefined) {
                const signal = new AbortController().signal
                Promise.resolve()
                  .then(() => commands.execute(agent, '/plan-build status', [], signal))
                  .catch(() => { /* ignore: command output is best-effort feedback */ })
              }
            },
          },
          ctx,
        )
        disposers.push(disposeShortcut)
      }
    }

    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
