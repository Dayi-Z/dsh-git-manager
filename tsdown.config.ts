import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'lib',
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-workspace',
  ],
})
