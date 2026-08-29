import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const clientDir = join(root, 'client')

const pluginId = 'gitcompass'
const inputFile = join(clientDir, 'index.cjs')
const outputFile = join(clientDir, 'client.js')
const mapInput = join(clientDir, 'index.cjs.map')
const mapOutput = join(clientDir, 'client.js.map')

let code = readFileSync(inputFile, 'utf-8')

// Preserve and remove sourcemap comment
let mapComment = ''
const smMatch = code.match(/\n\/\/# sourceMappingURL=index\.cjs\.map\s*$/)
if (smMatch) {
  code = code.slice(0, smMatch.index)
  mapComment = '\n//# sourceMappingURL=client.js.map'
}

// Replace the initial exports setup with module/exports scaffolding
code = code.replace(
  /^Object\.defineProperty\(exports, Symbol\.toStringTag, \{ value: "Module" \}\);\s*\n?/,
  'var module = { exports: {} };\nvar exports = module.exports;\nObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n'
)

// Wrap in __ModuleLoader__.load factory
code = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {\n${code}\nreturn module.exports;\n} });${mapComment}\n`

writeFileSync(outputFile, code, 'utf-8')

// Update sourcemap to reference the renamed output file
if (existsSync(mapInput)) {
  const map = JSON.parse(readFileSync(mapInput, 'utf-8'))
  map.file = 'client.js'
  writeFileSync(mapOutput, JSON.stringify(map), 'utf-8')
}

// Remove intermediate tsdown outputs AND old index.js / index.js.map
for (const f of ['index.cjs', 'index.cjs.map', 'index.d.cts', 'index.d.cts.map', 'index.js', 'index.js.map']) {
  const fp = join(clientDir, f)
  if (existsSync(fp)) rmSync(fp)
}

console.log(`[normalize-client-banner] wrote ${outputFile}`)
