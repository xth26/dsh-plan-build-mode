import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { DEFAULT_SHORTCUT } from '../src/helpers.ts'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

function makeSession(events: Session['events'] = []): Session {
  return {
    events,
    append: (_type, data) => {
      events.push({ type: _type, data, seq: events.length + 1, time: Date.now() } as any)
    },
  } as unknown as Session
}

function makeAgent(events: Session['events'] = []) {
  return { session: makeSession(events) }
}

interface MockCtx {
  effect: (fn: () => (() => void) | void) => () => void
  systemPrompt: { section: ReturnType<typeof vi.fn> }
  on: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
  logger: { warn: ReturnType<typeof vi.fn> }
}

interface SetupOptions {
  /** Fake ctx.tuiShortcuts registry; omitted simulates a web/headless composition. */
  tuiShortcuts?: { register: ReturnType<typeof vi.fn> }
  /** Agents ctx.agents.list() returns; defaults to []. */
  agents?: unknown[]
  /** The fake command service's execute spy; defaults to a fresh vi.fn. */
  commandsExecute?: ReturnType<typeof vi.fn>
}

function setupCtx(options: SetupOptions = {}): MockCtx & {
  agents: { list: ReturnType<typeof vi.fn> }
  _commandCtx: {
    commands: { register: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> }
    inject: ReturnType<typeof vi.fn>
  }
} {
  const disposers: (() => void)[] = []
  const systemPrompt = { section: vi.fn() }
  const on = vi.fn((_event, handler) => {
    disposers.push(() => {})
    return () => {}
  })
  const commandsExecute = options.commandsExecute ?? vi.fn()
  const commandCtx = {
    commands: { register: vi.fn(), execute: commandsExecute },
    inject: vi.fn((services: string[], innerCb: (tuiCtx: unknown) => void) => {
      if (services.includes('tuiShortcuts')) {
        innerCb({
          get: (svc: string) => (svc === 'tuiShortcuts' ? options.tuiShortcuts : undefined),
        })
      }
      return undefined
    }),
  }
  const inject = vi.fn((_services, cb) => {
    cb(commandCtx)
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
    agents: { list: vi.fn(() => options.agents ?? []) },
    logger: { warn: vi.fn() },
  }
  return Object.assign(ctx as any, { _commandCtx: commandCtx })
}

function invokeCommand(ctx: MockCtx, rawInput: string, events: Session['events'] = []): CommandResult {
  let handler: ((invocation: CommandInvocation) => CommandResult) | undefined
  const captureCtx = {
    commands: {
      register: (def: { handler: (invocation: CommandInvocation) => CommandResult }) => {
        handler = def.handler
      },
    },
    inject: () => undefined,
  }
  ctx.inject.mock.calls[0][1](captureCtx)
  return handler!({ agent: makeAgent(events), rawInput } as CommandInvocation)
}

function getSystemPromptText(ctx: MockCtx): (context: AssembleContext) => string {
  return ctx.systemPrompt.section.mock.calls[0][0].text
}

function getToolsListener(ctx: MockCtx) {
  return ctx.on.mock.calls.find(([event]) => event === 'tools/pre-execute')?.[1]
}

function makeToolExecution(name: string, agent: ReturnType<typeof makeAgent>): ToolExecution {
  return { name, agent } as unknown as ToolExecution
}

describe('apply', () => {
  it('throws when planSandbox equals buildSandbox', () => {
    const ctx = setupCtx()
    expect(() => apply(ctx as any, { planSandbox: 'read-only', buildSandbox: 'read-only' })).toThrow(
      "planSandbox and buildSandbox must be different"
    )
  })

  it('registers the plan-build command', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(ctx.inject).toHaveBeenCalledWith(['commands'], expect.any(Function))
  })

  it('injects the plan-build:policy system prompt section', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(ctx.systemPrompt.section).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plan-build:policy', order: 56 })
    )
  })

  it('toggles to Plan mode with bare /plan-build', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const events: Session['events'] = []
    const result = invokeCommand(ctx, '', events)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Switched to plan mode.')
    expect(result.text).toContain('Run /plan-build again to switch back.')
    expect(events[0]).toMatchObject({ type: 'sandbox/mode', data: { mode: 'read-only' } })
  })

  it('toggles to Plan mode with /plan-build switch', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const events: Session['events'] = []
    const result = invokeCommand(ctx, 'switch', events)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Switched to plan mode.')
    expect(result.text).toContain('Run /plan-build again to switch back.')
    expect(events[0]).toMatchObject({ type: 'sandbox/mode', data: { mode: 'read-only' } })
  })

  it('reports status in Plan mode', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const events: Session['events'] = [{ type: 'sandbox/mode', data: { mode: 'read-only' }, seq: 1, time: 0 } as any]
    const result = invokeCommand(ctx, 'status', events)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Plan mode is active')
    expect(result.text).not.toContain('Switched')
  })

  it('reports status in Build mode', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const events: Session['events'] = [{ type: 'sandbox/mode', data: { mode: 'workspace-write' }, seq: 1, time: 0 } as any]
    const result = invokeCommand(ctx, 'status', events)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Build mode is active')
    expect(result.text).not.toContain('Switched')
  })

  it('toggles back to Build mode with bare /plan-build', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const events: Session['events'] = [{ type: 'sandbox/mode', data: { mode: 'read-only' }, seq: 1, time: 0 } as any]
    const result = invokeCommand(ctx, '', events)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Switched to build mode.')
    expect(result.text).toContain('Run /plan-build again to switch back.')
    expect(events[1]).toMatchObject({ type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  })

  it('switches to Plan mode explicitly', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const events: Session['events'] = []
    const result = invokeCommand(ctx, 'switch plan', events)
    expect(result.kind).toBe('success')
    expect(result.text).toBe('Switched to plan mode.')
    expect(events[0]).toMatchObject({ type: 'sandbox/mode', data: { mode: 'read-only' } })
  })

  it('switches to Build mode explicitly', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const events: Session['events'] = [{ type: 'sandbox/mode', data: { mode: 'read-only' }, seq: 1, time: 0 } as any]
    const result = invokeCommand(ctx, 'switch build', events)
    expect(result.kind).toBe('success')
    expect(result.text).toBe('Switched to build mode.')
    expect(events[1]).toMatchObject({ type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  })

  it('reports already active mode', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const events: Session['events'] = [{ type: 'sandbox/mode', data: { mode: 'read-only' }, seq: 1, time: 0 } as any]
    const result = invokeCommand(ctx, 'switch plan', events)
    expect(result.kind).toBe('success')
    expect(result.text).toBe('Already in plan mode.')
  })

  it('rejects invalid arguments', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const result = invokeCommand(ctx, 'foobar')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Usage: /plan-build (toggle)')
  })

  it('system prompt section describes Plan mode', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const text = getSystemPromptText(ctx)
    const agent = makeAgent([{ type: 'sandbox/mode', data: { mode: 'read-only' }, seq: 1, time: 0 } as any])
    const prompt = text({ agent } as AssembleContext)
    expect(prompt).toContain('You are in OpenCode Plan Mode')
    expect(prompt).toContain('python -B')
    expect(prompt).toContain('read data files')
  })

  it('system prompt section describes Build mode', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const text = getSystemPromptText(ctx)
    const agent = makeAgent([{ type: 'sandbox/mode', data: { mode: 'workspace-write' }, seq: 1, time: 0 } as any])
    const prompt = text({ agent } as AssembleContext)
    expect(prompt).toContain('You are in OpenCode Build Mode')
    expect(prompt).toContain('/plan-build')
    expect(prompt).toContain('Plan Mode')
  })

  it('system prompt section is empty when agent is undefined', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const text = getSystemPromptText(ctx)
    expect(text({} as AssembleContext)).toBe('')
  })
})

describe('tools/pre-execute', () => {
  it('denies write tool in Plan mode', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)
    const agent = makeAgent([{ type: 'sandbox/mode', data: { mode: 'read-only' }, seq: 1, time: 0 } as any])
    const result = await listener(makeToolExecution('write', agent), async () => ({ kind: 'allow' } as PreToolDecision))
    expect(result).toMatchObject({ kind: 'deny' })
    expect((result as any).reason).toContain('forbidden in Plan Mode')
  })

  it('allows read tool in Plan mode', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)
    const agent = makeAgent([{ type: 'sandbox/mode', data: { mode: 'read-only' }, seq: 1, time: 0 } as any])
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('read', agent), next)
    expect(next).toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'allow' })
  })

  it('allows write tool in Build mode', async () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    const listener = getToolsListener(ctx)
    const agent = makeAgent([{ type: 'sandbox/mode', data: { mode: 'workspace-write' }, seq: 1, time: 0 } as any])
    const next = vi.fn(async () => ({ kind: 'allow' } as PreToolDecision))
    const result = await listener(makeToolExecution('write', agent), next)
    expect(next).toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'allow' })
  })
})

describe('tuiShortcuts', () => {
  it('reaches the tuiShortcuts seam but binds nothing in web/headless compositions', () => {
    const ctx = setupCtx()
    apply(ctx as any, {})
    expect(ctx._commandCtx.inject).toHaveBeenCalledWith(['tuiShortcuts'], expect.any(Function))
  })

  it('registers the default combo against ctx.tuiShortcuts', () => {
    const register = vi.fn()
    const ctx = setupCtx({ tuiShortcuts: { register } })
    apply(ctx as any, {})
    expect(register).toHaveBeenCalledWith(
      DEFAULT_SHORTCUT,
      expect.objectContaining({ description: expect.stringContaining('Plan and Build') }),
      expect.anything(),
    )
  })

  it('honours a configured string shortcut', () => {
    const register = vi.fn()
    const ctx = setupCtx({ tuiShortcuts: { register } })
    apply(ctx as any, { shortcut: 'alt+p' })
    expect(register).toHaveBeenCalledWith('alt+p', expect.any(Object), expect.anything())
  })

  it('registers every combo of a configured array', () => {
    const register = vi.fn()
    const ctx = setupCtx({ tuiShortcuts: { register } })
    apply(ctx as any, { shortcut: ['alt+p', 'ctrl+shift+k'] })
    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledWith('alt+p', expect.any(Object), expect.anything())
    expect(register).toHaveBeenCalledWith('ctrl+shift+k', expect.any(Object), expect.anything())
  })

  it('runs /plan-build through the command service when the shortcut fires', async () => {
    const register = vi.fn()
    const commandsExecute = vi.fn(async () => ({ kind: 'success', text: 'Switched to plan mode.' }))
    const ctx = setupCtx({ tuiShortcuts: { register }, commandsExecute, agents: [makeAgent()] })
    apply(ctx as any, {})
    const handler = register.mock.calls[0][1].handler as () => Promise<void>
    await handler()
    expect(commandsExecute).toHaveBeenCalledWith(
      expect.anything(),
      '/plan-build',
      [],
      expect.any(AbortSignal),
    )
  })

  it('shortcut handler is a no-op without a live agent', async () => {
    const register = vi.fn()
    const commandsExecute = vi.fn()
    const ctx = setupCtx({ tuiShortcuts: { register }, commandsExecute, agents: [] })
    apply(ctx as any, {})
    const handler = register.mock.calls[0][1].handler as () => Promise<void>
    await handler()
    expect(commandsExecute).not.toHaveBeenCalled()
  })
})
