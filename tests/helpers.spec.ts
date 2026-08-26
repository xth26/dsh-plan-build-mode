import { describe, expect, it } from 'vitest'
import {
  currentSandboxMode,
  DEFAULT_BUILD_SANDBOX,
  DEFAULT_PLAN_SANDBOX,
  isPlanModeActive,
  planModeDenial,
  setPlanBuildMode,
  WRITE_TOOLS,
} from '../src/helpers.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

function event(type: SessionEvent['type'], data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

function session(events: SessionEvent[]): Session {
  const appended: SessionEvent[] = []
  return {
    events,
    append: (_type: SessionEvent['type'], data: unknown) => {
      appended.push(event(_type, data, events.length + appended.length + 1))
      events.push(appended[appended.length - 1]!)
    },
  } as unknown as Session
}

describe('isPlanModeActive', () => {
  it('returns false when no sandbox event exists', () => {
    expect(isPlanModeActive([], DEFAULT_PLAN_SANDBOX)).toBe(false)
  })

  it('returns true when current sandbox matches planSandbox', () => {
    const events = [event('sandbox/mode', { mode: 'read-only' })]
    expect(isPlanModeActive(events, DEFAULT_PLAN_SANDBOX)).toBe(true)
  })

  it('returns false when current sandbox is build mode', () => {
    const events = [event('sandbox/mode', { mode: 'workspace-write' })]
    expect(isPlanModeActive(events, DEFAULT_PLAN_SANDBOX)).toBe(false)
  })

  it('returns false when planSandbox is not read-only', () => {
    const events = [event('sandbox/mode', { mode: 'workspace-write' })]
    expect(isPlanModeActive(events, 'workspace-write')).toBe(true)
    expect(isPlanModeActive(events, 'danger-full-access')).toBe(false)
  })
})

describe('currentSandboxMode', () => {
  it('returns undefined without sandbox events', () => {
    expect(currentSandboxMode([])).toBeUndefined()
  })

  it('returns the most recent sandbox mode', () => {
    const events = [
      event('sandbox/mode', { mode: 'workspace-write' }),
      event('sandbox/mode', { mode: 'read-only' }),
    ]
    expect(currentSandboxMode(events)).toBe('read-only')
  })
})

describe('setPlanBuildMode', () => {
  it('appends a sandbox/mode event for plan', () => {
    const s = session([])
    setPlanBuildMode({ session: s } as any, 'plan', DEFAULT_PLAN_SANDBOX, DEFAULT_BUILD_SANDBOX)
    expect(s.events[0]).toMatchObject({ type: 'sandbox/mode', data: { mode: DEFAULT_PLAN_SANDBOX } })
  })

  it('appends a sandbox/mode event for build', () => {
    const s = session([])
    setPlanBuildMode({ session: s } as any, 'build', DEFAULT_PLAN_SANDBOX, DEFAULT_BUILD_SANDBOX)
    expect(s.events[0]).toMatchObject({ type: 'sandbox/mode', data: { mode: DEFAULT_BUILD_SANDBOX } })
  })
})

describe('planModeDenial', () => {
  it('allows read in plan mode', () => {
    const exec = {
      agent: { session: session([event('sandbox/mode', { mode: DEFAULT_PLAN_SANDBOX })]) },
      name: 'read',
    } as any
    expect(planModeDenial(exec, DEFAULT_PLAN_SANDBOX, WRITE_TOOLS)).toBeUndefined()
  })

  it('denies write in plan mode', () => {
    const exec = {
      agent: { session: session([event('sandbox/mode', { mode: DEFAULT_PLAN_SANDBOX })]) },
      name: 'write',
    } as any
    expect(planModeDenial(exec, DEFAULT_PLAN_SANDBOX, WRITE_TOOLS)).toContain('forbidden in Plan Mode')
  })

  it('allows write in build mode', () => {
    const exec = {
      agent: { session: session([event('sandbox/mode', { mode: DEFAULT_BUILD_SANDBOX })]) },
      name: 'write',
    } as any
    expect(planModeDenial(exec, DEFAULT_PLAN_SANDBOX, WRITE_TOOLS)).toBeUndefined()
  })

  it('allows write when configured planSandbox is not read-only', () => {
    const exec = {
      agent: { session: session([event('sandbox/mode', { mode: 'workspace-write' })]) },
      name: 'write',
    } as any
    expect(planModeDenial(exec, 'workspace-write', WRITE_TOOLS)).toBeUndefined()
  })
})
