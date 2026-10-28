/**
 * Pure helpers for OpenCode-style Plan/Build mode switching.
 * @module dsh-plan-build-mode/helpers
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ModeStore } from './store.ts'
import type { PlanBuildMode } from './types.ts'

/**
 * Default sandbox mode while Plan mode is active.
 *
 * The OpenCode-aligned shipped default is `workspace-write`: "read-only" in
 * Plan mode is enforced by the permission gate (with the plans-directory
 * carve-out), not by the sandbox — so plan files can persist while everything
 * else stays read-only. Kept in code (not in the bundle patch) so the plugin
 * can be enabled from the plugin market as a pure insert.
 */
export const DEFAULT_PLAN_SANDBOX: SandboxMode = 'workspace-write'

/** Default sandbox mode while Build mode is active. */
export const DEFAULT_BUILD_SANDBOX: SandboxMode = 'workspace-write'

/**
 * The session's durable Plan/Build mode from the mode store, falling back to
 * an inference from the last `sandbox/mode` override for sessions that only
 * carry legacy sandbox state. Returns undefined only when neither source has
 * a value — callers treat that as Build mode.
 */
export function currentPlanBuildMode(
  store: ModeStore,
  session: Session,
): PlanBuildMode | undefined {
  return store.get(session.id)
}

/**
 * Whether the session is currently in OpenCode Plan mode. The mode store is
 * authoritative; sessions without a stored record are in Build mode.
 */
export function isPlanModeActive(
  store: ModeStore,
  session: Session,
): boolean {
  return store.get(session.id) === 'plan'
}

/**
 * Persist the Plan/Build mode in the mode store and — only when the target
 * sandbox actually differs from the current override — record the
 * `sandbox/mode` override through the official `setSandboxMode()` write path
 * so sandbox enforcement follows the mode switch.
 */
export function setPlanBuildMode(
  store: ModeStore,
  agent: Agent,
  mode: PlanBuildMode,
  planSandbox: SandboxMode,
  buildSandbox: SandboxMode,
  currentSandbox: SandboxMode | undefined,
): void {
  store.set(agent.session.id, mode)
  const target: SandboxMode = mode === 'plan' ? planSandbox : buildSandbox
  if (currentSandbox !== target) {
    setSandboxMode(agent.session, target)
  }
}
