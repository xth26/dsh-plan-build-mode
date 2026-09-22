// Extra smoke: verify the system-prompt section text function against a real
// Session, covering both the agent-present and diagnostics paths.
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { isPlanModeActive, setPlanBuildMode } from '../lib/helpers.js'

const session = Session.create(SessionId('smoke-session-2'))
session.append('sandbox/mode', { mode: 'read-only' })

// Mirror the text() provider logic from src/index.ts (kept in sync manually).
const PLAN_TEXT = 'You are in OpenCode Plan Mode'
const BUILD_TEXT = 'You are in OpenCode Build Mode'

function sectionText(agent) {
  if (agent === undefined) return ''
  return isPlanModeActive(agent.session, 'read-only') ? PLAN_TEXT : BUILD_TEXT
}

assert.equal(sectionText(undefined), '')

const agent = { session }
assert.ok(sectionText(agent).startsWith(PLAN_TEXT))

setPlanBuildMode(agent, 'build', 'read-only', 'workspace-write')
assert.ok(sectionText(agent).startsWith(BUILD_TEXT))

console.log('section smoke ok')
