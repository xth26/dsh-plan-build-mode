/**
 * Package-owned invariant companion for `dsh-plan-build-mode`.
 *
 * This plugin stores its state entirely in the existing `sandbox/mode` event
 * (owned by `@deepseek-ai/dsh-sandbox-policy`), so there is no custom event
 * type to validate. The companion is kept as a no-op installer so downstream
 * deployments can still mount `dsh-plan-build-mode/invariant` if desired.
 *
 * @module dsh-plan-build-mode/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'dsh-plan-build-mode-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'] as const

/** No-op installer: state lives in sandbox/mode, validated by dsh-sandbox-policy. */
const install: InvariantInstaller = Object.assign(() => {
  // Intentionally empty: this plugin does not introduce new session event types.
}, { inject: [] })

/**
 * Register the plan-build-mode invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context & { invariants: unknown }): Promise<() => void> =>
  Promise.resolve(
    (ctx.invariants as { register(name: string, installer: InvariantInstaller): () => void }).register(
      'dsh-plan-build-mode',
      install,
    ),
  )
