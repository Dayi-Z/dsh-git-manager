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
  deps: {
    // 全部外置：宿主在运行时解析并注入 @deepseek-ai/* 模块。
    // 实证：dsh-better-sidebar / dsh-find-plugin / dsh-web-search-pro 的 generation 里
    // 都没装 @deepseek-ai，却照样 import 它们——所以插件不该自带副本（也正是它们
    // 在 package.json 里声明为 peerDependencies 的原因）。
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-subprocess',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-workspace',
    ],
  },
})
