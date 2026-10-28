import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('cordis.patch.yml', () => {
  const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')

  it('inserts the plugin row and extends the official permission presets', () => {
    expect(patch).toContain('- insert:')
    expect(patch).toContain('id: plan-build-mode')
    expect(patch).toContain("name: '@xth26/dsh-plan-build-mode'")
    // The plugin row itself carries no config (hot-mountable pure insert).
    expect(patch).not.toMatch(/- id: plan-build-mode[\s\S]*?^      config:/m)
    // The permission override restates the shipped presets and adds the
    // OpenCode-style modes; no `!!js` (keeps the patch statically valid).
    expect(patch).toContain('id: permission')
    expect(patch).toContain('oc-plan')
    expect(patch).toContain('oc-build')
    expect(patch).toContain('danger-full-access')
    expect(patch).not.toMatch(/!!js/)
  })
})
