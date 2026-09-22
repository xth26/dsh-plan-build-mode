/**
 * Package-owned invariant companion for `dsh-plan-build-mode`.
 *
 * The plugin stores its Plan/Build mode in its own `plan-build/mode` session
 * event, so the companion validates that event's payload before it reaches
 * the durable log. The `sandbox/mode` event it also writes is validated by
 * `@deepseek-ai/dsh-sandbox-policy`.
 *
 * @module dsh-plan-build-mode/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'dsh-plan-build-mode-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'] as const

/** Validate one `plan-build/mode` event before it reaches the durable log. */
function validateEvent(event: { type: string; data: unknown }, fail: (message: string) => never): void {
  if (event.type !== 'plan-build/mode') return
  const mode = (event.data as { mode?: unknown } | null | undefined)?.mode
  if (mode !== 'plan' && mode !== 'build') {
    fail(`plan-build/mode carries invalid mode ${JSON.stringify(mode)}; expected 'plan' or 'build'`)
  }
}

/** Validate loaded and newly appended plan-build/mode state. */
const install: InvariantInstaller = Object.assign(
  (ctx: Context & { sessions: { list(): { snapshotEvents(): readonly { type: string; data: unknown }[] }[] } }, fail: (message: string) => never) => {
    const seed = (session: { snapshotEvents(): readonly { type: string; data: unknown }[] }) => {
      for (const event of session.snapshotEvents()) validateEvent(event, fail)
    }
    for (const session of ctx.sessions.list()) seed(session)
    ctx.on('session/created', (session: { snapshotEvents(): readonly { type: string; data: unknown }[] }) => {
      seed(session)
    }, { global: true })
    ctx.on('internal/dispatch', (_mode: string, eventName: string, args: any[]) => {
      if (eventName !== 'session/event') return
      const event = args[1] as { type: string; data: unknown }
      validateEvent(event, fail)
    }, { global: true })
  },
  { inject: ['sessions'] },
)

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
