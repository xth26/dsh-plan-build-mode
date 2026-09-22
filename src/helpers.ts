/**
 * Pure helpers for OpenCode-style Plan/Build mode switching.
 * @module dsh-plan-build-mode/helpers
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
// Pulls in the 'sandbox/mode' SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
// Pulls in the 'plan-build/mode' SessionEventMap merge.
import type {} from './types.ts'

/** Default sandbox mode while Plan mode is active. */
export const DEFAULT_PLAN_SANDBOX: SandboxMode = 'read-only'

/** Default sandbox mode while Build mode is active. */
export const DEFAULT_BUILD_SANDBOX: SandboxMode = 'workspace-write'

/** Tools forbidden while in Plan mode. */
export const WRITE_TOOLS = new Set(['write', 'edit'])

/** The durable Plan/Build mode event owned by this plugin. */
export const MODE_EVENT = 'plan-build/mode' as const

/** A session's Plan/Build mode. */
export type PlanBuildMode = 'plan' | 'build'

/**
 * Return the most recently written sandbox mode for a session, or undefined
 * when the session has never switched.
 *
 * DSH >= 0.1.5 removed the `session.events` snapshot getter; the log is read
 * through `session.snapshotEvents()` instead (an immutable, cached full-log
 * snapshot with the same element shape).
 */
export function currentSandboxMode(session: Session): SandboxMode | undefined {
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type === 'sandbox/mode') {
      return event.data.mode
    }
  }
  return undefined
}

/**
 * The session's durable Plan/Build mode: the last `plan-build/mode` event, or
 * an inference from the last `sandbox/mode` event against `planSandbox` for
 * sessions created before the mode event existed. Returns undefined only when
 * the session log carries neither.
 */
export function currentPlanBuildMode(session: Session, planSandbox: SandboxMode): PlanBuildMode | undefined {
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type === MODE_EVENT) {
      return event.data.mode
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type === 'sandbox/mode') {
      return event.data.mode === planSandbox ? 'plan' : 'build'
    }
  }
  return undefined
}

/**
 * Whether the session is currently in OpenCode Plan mode. The plugin's own
 * `plan-build/mode` event is authoritative; legacy sessions (only
 * `sandbox/mode` events) fall back to "current sandbox equals planSandbox".
 */
export function isPlanModeActive(session: Session, planSandbox: SandboxMode): boolean {
  return currentPlanBuildMode(session, planSandbox) === 'plan'
}

/**
 * Append the durable `plan-build/mode` event to switch between Plan and Build
 * mode, and — only when the target sandbox actually differs from the current
 * one — the `sandbox/mode` event for sandbox enforcement.
 */
export function setPlanBuildMode(
  agent: Agent,
  mode: PlanBuildMode,
  planSandbox: SandboxMode,
  buildSandbox: SandboxMode,
): void {
  agent.session.append(MODE_EVENT, { mode })
  const target: SandboxMode = mode === 'plan' ? planSandbox : buildSandbox
  if (currentSandboxMode(agent.session) !== target) {
    agent.session.append('sandbox/mode', { mode: target })
  }
}

/**
 * Compute a denial reason if a tool call should be blocked in Plan mode.
 * Returns `undefined` when the call is allowed.
 *
 * Write tools are denied only when Plan mode is active AND Plan mode is
 * configured as read-only. If Plan mode is configured to a writable sandbox,
 * the plugin still tracks the mode but does not block tools — the real
 * protection is the read-only sandbox.
 *
 * Kept for backward compatibility; the plugin's full permission gate
 * (`permissions.ts`) supersedes this check.
 */
export function planModeDenial(
  exec: ToolExecution,
  planSandbox: SandboxMode,
  writeTools: ReadonlySet<string> = WRITE_TOOLS,
): string | undefined {
  if (exec.agent === undefined) return undefined
  if (planSandbox !== 'read-only') return undefined
  if (!isPlanModeActive(exec.agent.session, planSandbox)) return undefined
  if (writeTools.has(exec.name)) {
    return `Tool '${exec.name}' is forbidden in Plan Mode. Run /plan-build (or /plan-build switch build) to leave Plan Mode before editing files.`
  }
  return undefined
}
