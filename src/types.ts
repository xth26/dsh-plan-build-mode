/**
 * Shared types for `dsh-plan-build-mode`.
 * @module dsh-plan-build-mode/types
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/dsh-session/types' {
  // This plugin reuses the existing 'plan/mode' event from @deepseek-ai/dsh-plan-mode
  // for persistence compatibility. No new session event types are added.
}

/**
 * Deployment configuration for the Plan/Build mode plugin.
 */
export interface PlanBuildModeConfig {
  /**
   * Sandbox mode enforced while Plan mode is active.
   * @default 'read-only'
   */
  planSandbox?: SandboxMode
  /**
   * Sandbox mode enforced while Build mode is active.
   * @default 'workspace-write'
   */
  buildSandbox?: SandboxMode
  /**
   * Whether to deny known write tools while in Plan mode + read-only sandbox.
   * @default true
   */
  denyWriteTools?: boolean
  /**
   * Whether to inject the `plan-build:policy` system prompt section.
   * @default true
   */
  section?: boolean
}
