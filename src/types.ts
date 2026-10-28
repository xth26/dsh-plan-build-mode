/**
 * Shared types for `dsh-plan-build-mode`.
 * @module dsh-plan-build-mode/types
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {
  ExternalDirectoryConfig,
  ModePermissionConfig,
  PermissionValue,
  ToolCategory,
} from './permissions.ts'

/**
 * A session's Plan/Build mode.
 */
export type PlanBuildMode = 'plan' | 'build'

/**
 * Deployment configuration for the Plan/Build mode plugin.
 */
export interface PlanBuildModeConfig {
  /**
   * Sandbox mode enforced while Plan mode is active.
   * The OpenCode-aligned default is `workspace-write`, so Plan-mode
   * read-only is enforced by the permission gate (with the plans-directory
   * carve-out) instead of the sandbox — this lets plan files persist.
   * @default 'workspace-write'
   */
  planSandbox?: SandboxMode
  /**
   * Sandbox mode enforced while Build mode is active.
   * @default 'workspace-write'
   */
  buildSandbox?: SandboxMode
  /**
   * Whether Plan mode denies write-category tools (via the permission gate).
   * When false, Plan mode does not restrict writes by policy.
   * @default true
   */
  denyWriteTools?: boolean
  /**
   * Whether to inject the `plan-build:policy` system prompt section.
   * @default true
   */
  section?: boolean
  /**
   * Workspace-relative directory writable in Plan mode — the OpenCode
   * `.opencode/plans/` analog. Must stay inside the workspace.
   * @default '.opencode/plans'
   */
  plansDirectory?: string
  /**
   * Global tool permission categories (OpenCode `permission`). Scalar
   * `allow | ask | deny`, or object-syntax rules (`{ pattern: action, ... }`,
   * last-match-wins, `*` catch-all, `~`/`$HOME` expansion).
   */
  permission?: Partial<Record<ToolCategory, PermissionValue>>
  /**
   * External-directory access gate (OpenCode `external_directory`): paths
   * outside the session workspace are read freely by default
   * (`default: 'allow'`); set `default: 'ask'` to prompt for every external
   * access. Writes outside the workspace remain governed by the sandbox.
   */
  externalDirectory?: ExternalDirectoryConfig
  /**
   * Per-mode permission overrides, applied over the global `permission`
   * (OpenCode agent-over-global precedence). `plan` defaults to write-deny +
   * command-ask; `build` defaults to allow.
   */
  modes?: ModePermissionConfig
}
