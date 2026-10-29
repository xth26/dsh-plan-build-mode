import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { apply } from '../src/index.ts'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { MemoryModeStore } from '../src/store.ts'
import type { ModeStore } from '../src/store.ts'
import type { PlanBuildMode } from '../src/types.ts'

/** An absolute path guaranteed to sit outside the session working directory. */
const outsidePath = path.join(path.parse(process.cwd()).root, 'dsh-plan-build-mode-external.txt')

/**
 * A pre-seeded store whose records were set before `apply` ran — the mode the
 * plugin reads comes from the store, never from session-log events.
 */
function makeSeededStore(mode: PlanBuildMode | undefined, sessionId = 'test-session'): ModeStore {
  const store = new MemoryModeStore()
  if (mode !== undefined) store.set(sessionId, mode)
  return store
}

function makeSession(cwd = process.cwd(), sessionId = 'test-session'): Session {
  return {
    id: sessionId,
    header: { cwd },
    append: vi.fn(),
  } as unknown as Session
}

function makeAgent(store: ModeStore, cwd?: string, sessionId = 'test-session') {
  return { session: makeSession(cwd, sessionId), store }
}

interface ApprovalMock {
  request: ReturnType<typeof vi.fn>
}

interface MockCtx {
  effect: (fn: () => (() => void) | void) => () => void
  systemPrompt: { section: ReturnType<typeof vi.fn> }
  on: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
}

function setupCtx(options: { approval?: ApprovalMock; sandboxOverride?: string } = {}): MockCtx {
  const disposers: (() => void)[] = []
  const systemPrompt = { section: vi.fn() }
  const on = vi.fn((_event, _handler) => {
    disposers.push(() => {})
    return () => {}
  })
  const inject = vi.fn((_services, cb) => {
    cb({ commands: { register: vi.fn() } })
  })
  const get = vi.fn((name: string) => {
    if (name === 'approval') return options.approval
    if (name === 'sandboxPolicy') {
      return { overrideOf: () => options.sandboxOverride }
    }
    return undefined
  })
  const ctx = {
    effect: (fn: () => (() => void) | void) => {
      const dispose = fn()
      if (dispose) disposers.push(dispose)
      return () => {
        for (const d of disposers) d()
      }
    },
    systemPrompt,
    on,
    inject,
    get,
  }
  return ctx as any
}

interface RegisteredCommand {
  name: string
  handler: (invocation: CommandInvocation) => CommandResult
}

function registeredCommands(ctx: MockCtx): Record<string, RegisteredCommand['handler']> {
  const handlers: Record<string, RegisteredCommand['handler']> = {}
  const captureCtx = {
    commands: {
      register: (def: RegisteredCommand) => {
        handlers[def.name] = def.handler
      },
    },
  }
  ctx.inject.mock.calls[0]![1]!(captureCtx)
  return handlers
}

/** Invoke a command against an agent whose mode comes from the given store. */
function invokeCommand(
  ctx: MockCtx,
  store: ModeStore,
  name: string,
  rawInput: string,
): { result: CommandResult; session: Session } {
  const handlers = registeredCommands(ctx)
  const session = makeSession()
  const result = handlers[name]!({ agent: { session, store }, rawInput } as unknown as CommandInvocation)
  return { result, session }
}

function getSystemPromptText(ctx: MockCtx): (context: AssembleContext) => string {
  return ctx.systemPrompt.section.mock.calls[0]![0]!.text
}

function getToolsListener(ctx: MockCtx) {
  return ctx.on.mock.calls.find(([event]) => event === 'tools/pre-execute')?.[1]
}

function makeToolExecution(name: string, agent: unknown, args?: unknown): ToolExecution {
  return {
    name,
    agent,
    callId: 'call-1',
    signal: new AbortController().signal,
    arguments: args,
  } as unknown as ToolExecution
}

const PLAN_STORE = makeSeededStore('plan')
const BUILD_STORE = makeSeededStore('build')
const EMPTY_STORE = makeSeededStore(undefined)

describe('apply', () => {
  it('allows equal plan and build sandboxes (OpenCode-aligned config)', () => {
    const ctx = setupCtx()
    expect(() => apply(ctx as any, { planSandbox: 'workspace-write', buildSandbox: 'workspace-write' })).not.toThrow()
  })

  it('registers the plan-build and oc-permission commands (not colliding with dsh-permission-presets)', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(ctx.inject).toHaveBeenCalledWith(['commands'], expect.any(Function))
    const handlers = registeredCommands(ctx)
    expect(handlers['plan-build']).toBeTypeOf('function')
    expect(handlers['oc-permission']).toBeTypeOf('function')
    expect(handlers['permission']).toBeUndefined()
  })

  it('injects the plan-build:policy system prompt section', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(ctx.systemPrompt.section).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plan-build:policy', order: 56 })
    )
  })

  it('does not listen for session/created (no mode events are appended)', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const created = ctx.on.mock.calls.find(([event]) => event === 'session/created')
    expect(created).toBeUndefined()
  })
})

describe('plan-build command', () => {
  it('toggles from default build to plan without a redundant sandbox event (shared sandbox)', () => {
    const ctx = setupCtx({ sandboxOverride: 'workspace-write' })
    apply(ctx as any, {})
    const { result, session } = invokeCommand(ctx, new MemoryModeStore(), 'plan-build', '')
    expect(result).toMatchObject({ kind: 'success' })
    // The shared-sandbox default: mode lives in the store only; the sandbox
    // override is appended only when the target sandbox actually differs.
    expect((session.append as ReturnType<typeof vi.fn>).mock.calls).toEqual([])
  })

  it('writes the sandbox override when the target sandbox differs', () => {
    const ctx = setupCtx({ sandboxOverride: 'workspace-write' })
    apply(ctx as any, { planSandbox: 'read-only', buildSandbox: 'workspace-write' })
    const { result, session } = invokeCommand(ctx, new MemoryModeStore(), 'plan-build', '')
    expect(result).toMatchObject({ kind: 'success' })
    expect((session.append as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['sandbox/mode', { mode: 'read-only' }],
    ])
  })

  it('reports status for plan and build', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const plan = invokeCommand(ctx, PLAN_STORE, 'plan-build', 'status')
    expect(plan.result).toMatchObject({ kind: 'success' })
    expect((plan.result as any).text).toContain('Plan mode is active')
    const build = invokeCommand(ctx, BUILD_STORE, 'plan-build', 'status')
    expect((build.result as any).text).toContain('Build mode is active')
  })

  it('treats a store without a record as Build mode', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const { result } = invokeCommand(ctx, EMPTY_STORE, 'plan-build', 'status')
    expect((result as any).text).toContain('Build mode is active')
  })
})

describe('permission command', () => {
  it('reports status with the external default and allowlist', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const { result } = invokeCommand(ctx, BUILD_STORE, 'oc-permission', 'status')
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as any).text).toContain('external_directory default: allow')
  })

  it('manages the session allowlist', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const allow = invokeCommand(ctx, BUILD_STORE, 'oc-permission', 'allow ~/projects/personal/**')
    expect(allow.result).toMatchObject({ kind: 'success' })
    const status = invokeCommand(ctx, BUILD_STORE, 'oc-permission', 'status')
    expect((status.result as any).text).toContain('~/projects/personal/**')
    const deny = invokeCommand(ctx, BUILD_STORE, 'oc-permission', 'deny ~/projects/personal/**')
    expect(deny.result).toMatchObject({ kind: 'success' })
    const after = invokeCommand(ctx, BUILD_STORE, 'oc-permission', 'status')
    expect((after.result as any).text).toContain('(empty)')
  })

  it('rejects malformed usage', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const { result } = invokeCommand(ctx, BUILD_STORE, 'oc-permission', 'bogus')
    expect(result).toMatchObject({ kind: 'error' })
  })
})

describe('permission gate (tools/pre-execute)', () => {
  it('denies write in Plan mode with the historical phrase', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: PLAN_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('write', agent, { file_path: 'src/x.ts' }), next)
    expect(result).toMatchObject({ kind: 'deny' })
    expect((result as any).reason).toContain('forbidden in Plan Mode')
    expect(next).not.toHaveBeenCalled()
  })

  it('allows writing under the plans directory in Plan mode', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: PLAN_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('write', agent, { file_path: '.opencode/plans/x.md' }), next)
    expect(result).toMatchObject({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })

  it('allows read in Plan mode', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: PLAN_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('read', agent), next)
    expect(result).toMatchObject({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })

  it('allows write in Build mode', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: BUILD_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('write', agent, { file_path: 'src/x.ts' }), next)
    expect(result).toMatchObject({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })

  it('allows reading outside the workspace by default (no prompt)', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: BUILD_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('read', agent, { file_path: outsidePath }), next)
    expect(result).toMatchObject({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })

  it('asks and honors allowed-once for external reads when configured to ask', async () => {
    const approval: ApprovalMock = { request: vi.fn(async () => 'allowed-once') }
    const ctx = setupCtx({ approval })
    apply(ctx as any, { externalDirectory: { default: 'ask' } })
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: BUILD_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('read', agent, { file_path: outsidePath }), next)
    expect(approval.request).toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })

  it('fails closed when the external read ask is rejected', async () => {
    const approval: ApprovalMock = { request: vi.fn(async () => 'rejected') }
    const ctx = setupCtx({ approval })
    apply(ctx as any, { externalDirectory: { default: 'ask' } })
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: BUILD_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('read', agent, { file_path: outsidePath }), next)
    expect(result).toMatchObject({ kind: 'deny' })
    expect((result as any).reason).toContain('was rejected')
    expect(next).not.toHaveBeenCalled()
  })

  it('denies an external write with an escalation hint (no ask under workspace-write)', async () => {
    const approval: ApprovalMock = { request: vi.fn(async () => 'allowed-once') }
    const ctx = setupCtx({ approval })
    apply(ctx as any, { externalDirectory: { default: 'ask' } })
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: BUILD_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('write', agent, { file_path: outsidePath }), next)
    expect(result).toMatchObject({ kind: 'deny' })
    expect((result as any).reason).toContain('sandbox_permissions')
    expect(approval.request).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('denies .env reads under the default read permission', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: BUILD_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('read', agent, { file_path: 'src/.env' }), next)
    expect(result).toMatchObject({ kind: 'deny' })
    expect(next).not.toHaveBeenCalled()
  })

  it('allows bash in Plan mode by default (sandbox is the floor), and still honors explicit ask', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = { session: makeSession(), store: PLAN_STORE }
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('bash', agent, { command: 'ls' }), next)
    expect(next).toHaveBeenCalled()

    const ctx2 = setupCtx()
    apply(ctx2 as any, { modes: { plan: { bash: 'ask' } } })
    const listener2 = getToolsListener(ctx2)!
    const result2 = await listener2(makeToolExecution('bash', agent, { command: 'ls' }), next)
    expect(result2).toMatchObject({ kind: 'deny' })
    expect((result2 as any).reason).toContain('no approval channel')
  })
})

describe('system prompt text', () => {
  it('renders Plan-mode guidance', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const text = getSystemPromptText(ctx)({ agent: { session: makeSession(), store: PLAN_STORE } } as any)
    expect(text).toContain('You are in OpenCode Plan Mode')
    expect(text).toContain('python -B')
    expect(text).toContain('workspace-write sandbox')
  })

  it('renders Build-mode guidance', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const text = getSystemPromptText(ctx)({ agent: { session: makeSession(), store: BUILD_STORE } } as any)
    expect(text).toContain('You are in OpenCode Build Mode')
    expect(text).toContain('/plan-build')
  })

  it('returns empty text without an agent (diagnostics path)', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(getSystemPromptText(ctx)({} as any)).toBe('')
  })
})
