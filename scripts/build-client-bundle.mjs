// Build the browser client bundle (lib/client.js) from the tsc-compiled
// CommonJS output (lib/client/index.js), wrapping it in the DSH browser
// module-loader handoff. This mirrors the artifact contract emitted by the
// DSH workspace's tsdown client preset:
//
//   window.__ModuleLoader__.load({ id: "<package-name>", factory: (require) => {
//   var module = { exports: {} }; var exports = module.exports;
//   <bundle body>
//   return module.exports; } });
//
// The compiled body is pure CommonJS with no require() edges (the client
// consumes services through injected ctx faces only), so the wrapper needs no
// external resolution.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const body = (await readFile(resolve(root, 'lib/client/index.js'), 'utf8'))
  // The tsc sourceMappingURL points at the intermediate artifact; drop it so
  // the browser never chases a map next to the loader bundle.
  .replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '')

const bundle = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  body,
  'return module.exports; } });',
  '',
].join('\n')

await writeFile(resolve(root, 'lib/client.js'), bundle)
console.log('built lib/client.js')
