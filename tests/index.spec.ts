import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { apply } from '../src/index.ts'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

/** An absolute path guaranteed to sit outside the session working directory. */
const outsidePath = path.join(path.parse(process.cwd()).root, 'dsh-plan-build-mode-external.txt')

function makeSession(events: SessionEvent[] = [], cwd = process.cwd()): Session {
  const session = {
    id: 'test-session',
    header: { cwd },
    append: (_type: SessionEvent['type'], data: unknown) => {
      events.push({ type: _type, data, seq: events.length + 1, time: Date.now() } as any)
    },
  } as unknown as Session
  ;(session as any).snapshotEvents = () => events
  return session
}

function makeAgent(events: SessionEvent[] = [], cwd?: string) {
  return { session: makeSession(events, cwd) }
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

function setupCtx(options: { approval?: ApprovalMock } = {}): MockCtx {
  const disposers: (() => void)[] = []
  const systemPrompt = { section: vi.fn() }
  const on = vi.fn((_event, _handler) => {
    disposers.push(() => {})
    return () => {}
  })
  const inject = vi.fn((_services, cb) => {
    cb({ commands: { register: vi.fn() } })
  })
  const get = vi.fn((name: string) => (name === 'approval' ? options.approval : undefined))
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
  ctx.inject.mock.calls[0][1](captureCtx)
  return handlers
}

function invokeCommand(ctx: MockCtx, name: string, rawInput: string, events: SessionEvent[] = []): CommandResult {
  const handlers = registeredCommands(ctx)
  return handlers[name]!({ agent: makeAgent(events), rawInput } as CommandInvocation)
}

function getSystemPromptText(ctx: MockCtx): (context: AssembleContext) => string {
  return ctx.systemPrompt.section.mock.calls[0][0].text
}

function getToolsListener(ctx: MockCtx) {
  return ctx.on.mock.calls.find(([event]) => event === 'tools/pre-execute')?.[1]
}

function makeToolExecution(name: string, agent: ReturnType<typeof makeAgent>, args?: unknown): ToolExecution {
  return {
    name,
    agent,
    callId: 'call-1',
    signal: new AbortController().signal,
    arguments: args,
  } as unknown as ToolExecution
}

const PLAN_EVENT = { type: 'plan-build/mode', data: { mode: 'plan' }, seq: 1, time: 0 } as any
const BUILD_EVENT = { type: 'plan-build/mode', data: { mode: 'build' }, seq: 1, time: 0 } as any

describe('apply', () => {
  it('allows equal plan and build sandboxes (OpenCode-aligned B config)', () => {
    const ctx = setupCtx()
    expect(() => apply(ctx as any, { planSandbox: 'workspace-write', buildSandbox: 'workspace-write' })).not.toThrow()
  })

  it('registers the plan-build and permission commands', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(ctx.inject).toHaveBeenCalledWith(['commands'], expect.any(Function))
    const handlers = registeredCommands(ctx)
    expect(handlers['plan-build']).toBeTypeOf('function')
    expect(handlers['permission']).toBeTypeOf('function')
  })

  it('injects the plan-build:policy system prompt section', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(ctx.systemPrompt.section).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plan-build:policy', order: 56 })
    )
  })

  it('pins a mode event on session creation', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(ctx.on).toHaveBeenCalledWith('session/created', expect.any(Function))
  })
})

describe('plan-build command', () => {
  it('toggles from default build to plan and appends the mode events', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const events: SessionEvent[] = []
    const result = invokeCommand(ctx, 'plan-build', '', events)
    expect(result).toMatchObject({ kind: 'success' })
    const snapshot = (makeAgent(events).session as any).snapshotEvents()
    expect(snapshot).toHaveLength(2)
    expect(snapshot[0]).toMatchObject({ type: 'plan-build/mode', data: { mode: 'plan' } })
    expect(snapshot[1]).toMatchObject({ type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  })

  it('reports status for plan and build', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const plan = invokeCommand(ctx, 'plan-build', 'status', [PLAN_EVENT])
    expect(plan).toMatchObject({ kind: 'success' })
    expect((plan as any).text).toContain('Plan mode is active')
    const build = invokeCommand(ctx, 'plan-build', 'status', [BUILD_EVENT])
    expect((build as any).text).toContain('Build mode is active')
  })
})

describe('permission command', () => {
  it('reports status with the external default and allowlist', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const result = invokeCommand(ctx, 'permission', 'status')
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as any).text).toContain('external_directory default: allow')
  })

  it('manages the session allowlist', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const allow = invokeCommand(ctx, 'permission', 'allow ~/projects/personal/**')
    expect(allow).toMatchObject({ kind: 'success' })
    const status = invokeCommand(ctx, 'permission', 'status')
    expect((status as any).text).toContain('~/projects/personal/**')
    const deny = invokeCommand(ctx, 'permission', 'deny ~/projects/personal/**')
    expect(deny).toMatchObject({ kind: 'success' })
    const after = invokeCommand(ctx, 'permission', 'status')
    expect((after as any).text).toContain('(empty)')
  })

  it('rejects malformed usage', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const result = invokeCommand(ctx, 'permission', 'bogus')
    expect(result).toMatchObject({ kind: 'error' })
  })
})

describe('permission gate (tools/pre-execute)', () => {
  it('denies write in Plan mode with the historical phrase', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = makeAgent([PLAN_EVENT])
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
    const agent = makeAgent([PLAN_EVENT])
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('write', agent, { file_path: '.opencode/plans/x.md' }), next)
    expect(result).toMatchObject({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })

  it('allows read in Plan mode', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = makeAgent([PLAN_EVENT])
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('read', agent), next)
    expect(result).toMatchObject({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })

  it('allows write in Build mode', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = makeAgent([BUILD_EVENT])
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('write', agent, { file_path: 'src/x.ts' }), next)
    expect(result).toMatchObject({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })

  it('allows reading outside the workspace by default (no prompt)', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)!
    const agent = makeAgent([BUILD_EVENT])
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
    const agent = makeAgent([BUILD_EVENT])
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
    const agent = makeAgent([BUILD_EVENT])
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
    const agent = makeAgent([BUILD_EVENT])
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
    const agent = makeAgent([BUILD_EVENT])
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('read', agent, { file_path: 'src/.env' }), next)
    expect(result).toMatchObject({ kind: 'deny' })
    expect(next).not.toHaveBeenCalled()
  })

  it('fails closed to deny when an ask has no approval channel', async () => {
    const ctx = setupCtx()
    apply(ctx as any, { modes: { plan: { bash: 'ask' } } })
    const listener = getToolsListener(ctx)!
    const agent = makeAgent([PLAN_EVENT])
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('bash', agent, { command: 'ls' }), next)
    expect(result).toMatchObject({ kind: 'deny' })
    expect((result as any).reason).toContain('no approval channel')
  })
})

describe('system prompt text', () => {
  it('renders Plan-mode guidance', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const text = getSystemPromptText(ctx)({ agent: makeAgent([PLAN_EVENT]) } as any)
    expect(text).toContain('You are in OpenCode Plan Mode')
    expect(text).toContain('python -B')
    expect(text).toContain('read data files')
  })

  it('renders Build-mode guidance', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const text = getSystemPromptText(ctx)({ agent: makeAgent([BUILD_EVENT]) } as any)
    expect(text).toContain('You are in OpenCode Build Mode')
    expect(text).toContain('/plan-build')
  })

  it('returns empty text without an agent (diagnostics path)', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(getSystemPromptText(ctx)({} as any)).toBe('')
  })
})
