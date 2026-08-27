import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/client/index.ts',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'client',
  clean: true,
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  external: [
    'react',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-slots',
  ],
})
