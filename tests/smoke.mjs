// Smoke test against the real @deepseek-ai/dsh-session@0.1.5-rc.2 Session class.
// Run with: node tests/smoke.mjs
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

const session = Session.create(SessionId('smoke-session'))

// No mode event yet -> not in plan mode.
assert.equal(
  (await import('../lib/helpers.js')).isPlanModeActive(session, 'read-only'),
  false,
)

// Append a legacy sandbox/mode event (pre-0.5 sessions are inferred from it).
session.append('sandbox/mode', { mode: 'read-only' })

const { currentPlanBuildMode, isPlanModeActive, currentSandboxMode, setPlanBuildMode } =
  await import('../lib/helpers.js')

assert.equal(currentPlanBuildMode(session, 'read-only'), 'plan')
assert.equal(isPlanModeActive(session, 'read-only'), true)
assert.equal(currentSandboxMode(session), 'read-only')

// Switch to build mode: writes the plugin-owned mode event + the sandbox event.
setPlanBuildMode({ session }, 'build', 'read-only', 'workspace-write')
assert.equal(currentPlanBuildMode(session, 'read-only'), 'build')
assert.equal(isPlanModeActive(session, 'read-only'), false)
assert.equal(currentSandboxMode(session), 'workspace-write')

// Shared-sandbox (B) config: only the mode event changes.
setPlanBuildMode({ session }, 'plan', 'workspace-write', 'workspace-write')
assert.equal(currentPlanBuildMode(session, 'workspace-write'), 'plan')
assert.equal(currentSandboxMode(session), 'workspace-write')

console.log('smoke ok')
