import { describe, expect, it } from 'vitest'
import {
  currentPlanBuildMode,
  currentSandboxMode,
  DEFAULT_BUILD_SANDBOX,
  DEFAULT_PLAN_SANDBOX,
  isPlanModeActive,
  MODE_EVENT,
  planModeDenial,
  setPlanBuildMode,
  WRITE_TOOLS,
} from '../src/helpers.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

function event(type: SessionEvent['type'], data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

function session(events: SessionEvent[]): Session {
  const s = {
    snapshotEvents: () => events,
    append: (_type: SessionEvent['type'], data: unknown) => {
      events.push(event(_type, data, events.length + 1))
    },
  } as unknown as Session
  return s
}

describe('defaults', () => {
  it('keeps the OpenCode-aligned sandbox defaults (workspace-write for both modes)', () => {
    expect(DEFAULT_PLAN_SANDBOX).toBe('workspace-write')
    expect(DEFAULT_BUILD_SANDBOX).toBe('workspace-write')
  })
})

describe('isPlanModeActive', () => {
  it('returns false when no mode event exists', () => {
    expect(isPlanModeActive(session([]), DEFAULT_PLAN_SANDBOX)).toBe(false)
  })

  it('returns true when the plan-build/mode event is plan', () => {
    const s = session([event(MODE_EVENT, { mode: 'plan' })])
    expect(isPlanModeActive(s, DEFAULT_PLAN_SANDBOX)).toBe(true)
  })

  it('returns false when the plan-build/mode event is build', () => {
    const s = session([event(MODE_EVENT, { mode: 'build' })])
    expect(isPlanModeActive(s, DEFAULT_PLAN_SANDBOX)).toBe(false)
  })

  it('infers plan from a legacy sandbox/mode event matching planSandbox', () => {
    const s = session([event('sandbox/mode', { mode: 'workspace-write' })])
    expect(isPlanModeActive(s, DEFAULT_PLAN_SANDBOX)).toBe(true)
  })

  it('returns false when planSandbox is not read-only', () => {
    const s = session([event('sandbox/mode', { mode: 'workspace-write' })])
    expect(isPlanModeActive(s, 'workspace-write')).toBe(true)
    expect(isPlanModeActive(s, 'danger-full-access')).toBe(false)
  })

  it('prefers the plan-build/mode event over a legacy sandbox inference', () => {
    const s = session([
      event('sandbox/mode', { mode: 'workspace-write' }),
      event(MODE_EVENT, { mode: 'build' }),
    ])
    expect(isPlanModeActive(s, DEFAULT_PLAN_SANDBOX)).toBe(false)
  })
})

describe('currentSandboxMode', () => {
  it('returns undefined without sandbox events', () => {
    expect(currentSandboxMode(session([]))).toBeUndefined()
  })

  it('returns the most recent sandbox mode', () => {
    const s = session([
      event('sandbox/mode', { mode: 'workspace-write' }),
      event('sandbox/mode', { mode: 'read-only' }),
    ])
    expect(currentSandboxMode(s)).toBe('read-only')
  })
})

describe('currentPlanBuildMode', () => {
  it('returns undefined when the log has no mode events', () => {
    expect(currentPlanBuildMode(session([]), DEFAULT_PLAN_SANDBOX)).toBeUndefined()
  })

  it('returns the most recent plan-build/mode event', () => {
    const s = session([
      event(MODE_EVENT, { mode: 'plan' }),
      event(MODE_EVENT, { mode: 'build' }),
    ])
    expect(currentPlanBuildMode(s, DEFAULT_PLAN_SANDBOX)).toBe('build')
  })

  it('infers from sandbox/mode when no plan-build/mode exists', () => {
    expect(currentPlanBuildMode(session([event('sandbox/mode', { mode: 'workspace-write' })]), DEFAULT_PLAN_SANDBOX)).toBe('plan')
    expect(currentPlanBuildMode(session([event('sandbox/mode', { mode: 'read-only' })]), DEFAULT_PLAN_SANDBOX)).toBe('build')
  })
})

describe('setPlanBuildMode', () => {
  it('appends a plan-build/mode event and a sandbox/mode event for plan', () => {
    const s = session([])
    setPlanBuildMode({ session: s } as any, 'plan', DEFAULT_PLAN_SANDBOX, DEFAULT_BUILD_SANDBOX)
    expect(s.snapshotEvents()[0]).toMatchObject({ type: MODE_EVENT, data: { mode: 'plan' } })
    expect(s.snapshotEvents()[1]).toMatchObject({ type: 'sandbox/mode', data: { mode: DEFAULT_PLAN_SANDBOX } })
  })

  it('appends a plan-build/mode event and a sandbox/mode event for build', () => {
    const s = session([])
    setPlanBuildMode({ session: s } as any, 'build', DEFAULT_PLAN_SANDBOX, DEFAULT_BUILD_SANDBOX)
    expect(s.snapshotEvents()[0]).toMatchObject({ type: MODE_EVENT, data: { mode: 'build' } })
    expect(s.snapshotEvents()[1]).toMatchObject({ type: 'sandbox/mode', data: { mode: DEFAULT_BUILD_SANDBOX } })
  })

  it('skips the sandbox/mode event when the target sandbox is already active (shared sandbox, B)', () => {
    const s = session([event('sandbox/mode', { mode: 'workspace-write' })])
    setPlanBuildMode({ session: s } as any, 'plan', 'workspace-write', 'workspace-write')
    const snapshot = s.snapshotEvents()
    expect(snapshot).toHaveLength(2)
    expect(snapshot[1]).toMatchObject({ type: MODE_EVENT, data: { mode: 'plan' } })
  })
})

describe('planModeDenial', () => {
  it('allows read in plan mode', () => {
    const exec = {
      agent: { session: session([event(MODE_EVENT, { mode: 'plan' })]) },
      name: 'read',
    } as any
    expect(planModeDenial(exec, 'read-only', WRITE_TOOLS)).toBeUndefined()
  })

  it('denies write in plan mode under the legacy read-only sandbox', () => {
    const exec = {
      agent: { session: session([event(MODE_EVENT, { mode: 'plan' })]) },
      name: 'write',
    } as any
    expect(planModeDenial(exec, 'read-only', WRITE_TOOLS)).toContain('forbidden in Plan Mode')
  })

  it('allows write in build mode', () => {
    const exec = {
      agent: { session: session([event(MODE_EVENT, { mode: 'build' })]) },
      name: 'write',
    } as any
    expect(planModeDenial(exec, 'read-only', WRITE_TOOLS)).toBeUndefined()
  })

  it('does not gate writes under the OpenCode-aligned default (workspace-write)', () => {
    const exec = {
      agent: { session: session([event(MODE_EVENT, { mode: 'plan' })]) },
      name: 'write',
    } as any
    expect(planModeDenial(exec, DEFAULT_PLAN_SANDBOX, WRITE_TOOLS)).toBeUndefined()
  })

  it('allows write when configured planSandbox is not read-only', () => {
    const exec = {
      agent: { session: session([event(MODE_EVENT, { mode: 'plan' })]) },
      name: 'write',
    } as any
    expect(planModeDenial(exec, 'workspace-write', WRITE_TOOLS)).toBeUndefined()
  })
})
