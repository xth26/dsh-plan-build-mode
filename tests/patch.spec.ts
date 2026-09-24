import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('cordis.patch.yml', () => {
  const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')

  it('is a pure insert without a config block (plugin-market hot enable)', () => {
    expect(patch).toContain('- insert:')
    expect(patch).toContain('id: plan-build-mode')
    expect(patch).toContain("name: '@xth26/dsh-plan-build-mode'")
    expect(patch).not.toMatch(/^\s*config:/m)
    expect(patch).not.toMatch(/!!js/)
  })
})
