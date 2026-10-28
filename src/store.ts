/**
 * Durable mode storage for `dsh-plan-build-mode`.
 *
 * The Plan/Build mode is host-side plugin state, NOT session-log state:
 * `Session.append()` cannot mark an event `ignorable: true`, so a
 * plugin-owned event type would make sessions written by this plugin refuse
 * to reopen on any DSH build that lacks the plugin (the persistence read
 * path refuses unknown required events). The Harness-sanctioned home for
 * durable, schema-validated host state is the `storageDomain` KV facility;
 * an in-memory map keeps every capability working in assemblies that mount
 * no storage backend (headless, tests).
 *
 * @module dsh-plan-build-mode/store
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PlanBuildMode } from './types.ts'

/** The stored mode record shape. */
export interface ModeRecord {
  mode: PlanBuildMode
}

/** zod schema validating one stored mode record. */
const modeRecordSchema: ZodType<ModeRecord> = z.object({ mode: z.enum(['plan', 'build']) })

/** Loosely-typed table declaration (avoids deep generic inference). */
function modeTable() {
  return domainTable(modeRecordSchema)
}

/**
 * The plugin-owned domain declaration. Version 1 stores one record per
 * session id; bumping requires a hand migration (no automatic migration).
 *
 * Typed explicitly as `DomainSpec` (not via `defineDomain`'s literal
 * inference) — the generic inference over the zod-4 schema instantiates
 * excessively deep under this tsconfig.
 */
export const planBuildDomain: DomainSpec = defineDomain({
  name: 'plan_build_mode',
  version: 1,
  tables: { modes: modeTable() },
})

/** The minimal facility surface the store needs (kept loose to avoid deep
 * generic instantiation of the domain spec types). */
interface StorageDomainFacility {
  open(spec: unknown): Promise<unknown>
}

/** The opened-domain surface the store uses (structural, non-recursive). */
interface ModeDomain {
  table(name: 'modes'): KvTable<string, ModeRecord>
  close(): Promise<void>
}

/** The mode store interface both backends satisfy. */
export interface ModeStore {
  /** Read the durable mode for one session, or undefined when never set. */
  get(sessionId: SessionId): PlanBuildMode | undefined
  /** Persist the mode for one session. */
  set(sessionId: SessionId, mode: PlanBuildMode): void
  /** Drop one session's record (the session was disposed). */
  delete(sessionId: SessionId): void
  /** Release backend resources; safe to call for the in-memory store. */
  close(): Promise<void>
}

type ModeTable = KvTable<string, ModeRecord>

/** The domain-backed store; every write is durable before it resolves. */
export class DomainModeStore implements ModeStore {
  private readonly table: ModeTable
  private readonly domain: ModeDomain

  private constructor(domain: ModeDomain) {
    this.domain = domain
    this.table = domain.table('modes')
  }

  /** Open (or attach to) the plugin domain on the composed storage. */
  static async open(facility: StorageDomainFacility): Promise<DomainModeStore> {
    return new DomainModeStore(await facility.open(planBuildDomain) as ModeDomain)
  }

  get(sessionId: SessionId): PlanBuildMode | undefined {
    return this.table.get(sessionId)?.mode
  }

  set(sessionId: SessionId, mode: PlanBuildMode): void {
    void this.table.put(sessionId, { mode }).catch(() => {
      // Durability failure leaves memory untouched inside the domain; the
      // in-session gate still sees the in-memory value of the last accepted
      // write, so the failure is contained instead of breaking the command.
    })
  }

  delete(sessionId: SessionId): void {
    void this.table.delete(sessionId).catch(() => {})
  }

  async close(): Promise<void> {
    await this.domain.close()
  }
}

/** In-memory fallback for assemblies without a storage backend. */
export class MemoryModeStore implements ModeStore {
  private readonly records = new Map<SessionId, PlanBuildMode>()

  get(sessionId: SessionId): PlanBuildMode | undefined {
    return this.records.get(sessionId)
  }

  set(sessionId: SessionId, mode: PlanBuildMode): void {
    this.records.set(sessionId, mode)
  }

  delete(sessionId: SessionId): void {
    this.records.delete(sessionId)
  }

  /** Snapshot of all records, for handover to a domain-backed store. */
  snapshot(): readonly [SessionId, PlanBuildMode][] {
    return [...this.records.entries()]
  }

  async close(): Promise<void> {}
}

/**
 * Build the best available store: the domain-backed one when the assembly
 * mounts `storageDomain` with a backend, the in-memory one otherwise. Pass
 * `fallback` to seed the returned store with records written before the
 * domain opened (they are copied over so nothing written early is lost).
 */
export async function openModeStore(
  ctx: { get(name: string): unknown },
  fallback?: ModeStore,
): Promise<ModeStore> {
  const storageDomain = ctx.get('storageDomain') as StorageDomainFacility | undefined
  if (storageDomain !== undefined) {
    try {
      const store = await DomainModeStore.open(storageDomain)
      if (fallback instanceof MemoryModeStore) {
        // Writes that landed on the in-memory fallback before this resolved
        // must survive the swap.
        for (const [id, mode] of fallback.snapshot()) store.set(id, mode)
      }
      return store
    } catch {
      // No backend routed / facet missing: degrade instead of failing mount.
    }
  }
  return fallback ?? new MemoryModeStore()
}
