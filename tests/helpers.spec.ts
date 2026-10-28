import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BUILD_SANDBOX,
  DEFAULT_PLAN_SANDBOX,
  isPlanModeActive,
  setPlanBuildMode,
} from '../src/helpers.ts'
import { MemoryModeStore } from '../src/store.ts'
import type { ModeStore } from '../src/store.ts'

function agent(session: unknown): any {
  return { session }
}

describe('defaults', () => {
  it('keeps the OpenCode-aligned sandbox defaults (workspace-write for both modes)', () => {
    expect(DEFAULT_PLAN_SANDBOX).toBe('workspace-write')
    expect(DEFAULT_BUILD_SANDBOX).toBe('workspace-write')
  })
})

describe('isPlanModeActive', () => {
  it('returns false for an empty store', () => {
    expect(isPlanModeActive(new MemoryModeStore(), { id: 's1' } as any)).toBe(false)
  })

  it('reflects the stored mode', () => {
    const store: ModeStore = new MemoryModeStore()
    expect(isPlanModeActive(store, { id: 's1' } as any)).toBe(false)
    store.set('s1', 'plan')
    expect(isPlanModeActive(store, { id: 's1' } as any)).toBe(true)
    store.set('s1', 'build')
    expect(isPlanModeActive(store, { id: 's1' } as any)).toBe(false)
  })

  it('isolates sessions from each other', () => {
    const store: ModeStore = new MemoryModeStore()
    store.set('s1', 'plan')
    expect(isPlanModeActive(store, { id: 's1' } as any)).toBe(true)
    expect(isPlanModeActive(store, { id: 's2' } as any)).toBe(false)
  })
})

describe('setPlanBuildMode', () => {
  it('stores the mode and writes the sandbox override when it differs', () => {
    const store = new MemoryModeStore()
    const session = { id: 's1', append: vi.fn() }
    setPlanBuildMode(store, agent(session), 'plan', 'read-only', 'workspace-write', 'workspace-write')
    expect(store.get('s1')).toBe('plan')
    expect(session.append).toHaveBeenCalledWith('sandbox/mode', { mode: 'read-only' })
  })

  it('stores the mode and skips the sandbox override when it already matches', () => {
    const store = new MemoryModeStore()
    const session = { id: 's1', append: vi.fn() }
    setPlanBuildMode(store, agent(session), 'plan', 'workspace-write', 'workspace-write', 'workspace-write')
    expect(store.get('s1')).toBe('plan')
    expect(session.append).not.toHaveBeenCalled()
  })

  it('writes the build sandbox when switching to build', () => {
    const store = new MemoryModeStore()
    const session = { id: 's1', append: vi.fn() }
    setPlanBuildMode(store, agent(session), 'build', 'read-only', 'danger-full-access', 'read-only')
    expect(store.get('s1')).toBe('build')
    expect(session.append).toHaveBeenCalledWith('sandbox/mode', { mode: 'danger-full-access' })
  })
})
