/**
 * Shared types for `dsh-plan-build-mode`.
 * @module dsh-plan-build-mode/types
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/dsh-session/types' {
  // This plugin reuses the existing 'sandbox/mode' event from @deepseek-ai/dsh-sandbox-policy
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
  /**
   * Keyboard shortcut(s) that toggle between Plan and Build modes in clients
   * exposing a shortcut seam. dsh-tui binds them through `ctx.tuiShortcuts`;
   * the web client binds the same combos through its global keydown listener.
   * Combos use the `ctrl+alt+shift+p` grammar (ctrl or alt required).
   * @default ['ctrl+alt+shift+p']
   */
  shortcut?: string | readonly string[]
}
