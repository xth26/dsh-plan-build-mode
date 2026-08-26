/**
 * Pure helpers for OpenCode-style Plan/Build mode switching.
 * @module dsh-plan-build-mode/helpers
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
// Pulls in the 'sandbox/mode' SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Default sandbox mode while Plan mode is active. */
export const DEFAULT_PLAN_SANDBOX: SandboxMode = 'read-only'

/** Default sandbox mode while Build mode is active. */
export const DEFAULT_BUILD_SANDBOX: SandboxMode = 'workspace-write'

/** Tools forbidden while in Plan mode. */
export const WRITE_TOOLS = new Set(['write', 'edit'])

/**
 * Return the most recently written sandbox mode for a session, or undefined
 * when the session has never switched.
 */
export function currentSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type === 'sandbox/mode') {
      return event.data.mode
    }
  }
  return undefined
}

/**
 * Whether the session is currently in OpenCode Plan mode.
 * Plan mode is defined as the current sandbox mode matching the configured
 * planSandbox (read-only by default).
 */
export function isPlanModeActive(events: readonly SessionEvent[], planSandbox: SandboxMode): boolean {
  return currentSandboxMode(events) === planSandbox
}

/**
 * Append a `sandbox/mode` event to switch between Plan and Build mode.
 */
export function setPlanBuildMode(agent: Agent, mode: 'plan' | 'build', planSandbox: SandboxMode, buildSandbox: SandboxMode): void {
  const target: SandboxMode = mode === 'plan' ? planSandbox : buildSandbox
  agent.session.append('sandbox/mode', { mode: target })
}

/**
 * Compute a denial reason if a tool call should be blocked in Plan mode.
 * Returns `undefined` when the call is allowed.
 *
 * Write tools are denied only when Plan mode is active AND Plan mode is
 * configured as read-only. If Plan mode is configured to a writable sandbox,
 * the plugin still tracks the mode but does not block tools — the real
 * protection is the read-only sandbox.
 */
export function planModeDenial(
  exec: ToolExecution,
  planSandbox: SandboxMode,
  writeTools: ReadonlySet<string> = WRITE_TOOLS,
): string | undefined {
  if (exec.agent === undefined) return undefined
  if (planSandbox !== 'read-only') return undefined
  if (!isPlanModeActive(exec.agent.session.events, planSandbox)) return undefined
  if (writeTools.has(exec.name)) {
    return `Tool '${exec.name}' is forbidden in Plan Mode. Leave Plan Mode with /plan-build switch build before editing files.`
  }
  return undefined
}
