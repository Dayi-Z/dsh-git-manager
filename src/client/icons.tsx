// gitcompass 图标系统：16×16 网格、1.5 笔重、圆角端点、currentColor。
// 全部手绘内联 SVG——按 impeccable 工艺地板，禁止 emoji/Unicode 充当图标。
import type { JSX } from 'react'

export type IconName =
  | 'git-branch' | 'commit' | 'merge' | 'git-pr' | 'issue' | 'diff'
  | 'plus' | 'minus' | 'undo' | 'x' | 'check' | 'chevron-down' | 'chevron-right'
  | 'arrow-up' | 'arrow-down' | 'sync' | 'archive'
  | 'folder' | 'folder-tree' | 'list' | 'eye' | 'comment' | 'bot' | 'globe'
  | 'success' | 'alert' | 'copy' | 'external' | 'trash' | 'clock' | 'clock-reverse'
  | 'gear' | 'ban' | 'tag'

const PATHS: Record<IconName, JSX.Element> = {
  'git-branch': (
    <>
      <circle cx="4" cy="3.6" r="1.6" />
      <circle cx="4" cy="12.4" r="1.6" />
      <circle cx="12" cy="5" r="1.6" />
      <path d="M4 5.2v5.6" />
      <path d="M12 6.6c0 2.6-2.4 3-6.2 3.4" />
    </>
  ),
  commit: (
    <>
      <circle cx="8" cy="8" r="2.7" />
      <path d="M1.5 8h3.8M10.7 8h3.8" />
    </>
  ),
  merge: (
    <>
      <circle cx="4" cy="3.6" r="1.6" />
      <circle cx="4" cy="12.4" r="1.6" />
      <circle cx="12" cy="12.4" r="1.6" />
      <path d="M4 5.2v5.6" />
      <path d="M4 5.6c0 3.2 3.8 2.6 6.2 5" />
    </>
  ),
  'git-pr': (
    <>
      <circle cx="4" cy="3.6" r="1.6" />
      <circle cx="4" cy="12.4" r="1.6" />
      <path d="M4 5.2v5.6" />
      <path d="M9.4 3h1.4A2.1 2.1 0 0 1 12.9 5.1v4.4" />
      <path d="M10.9 7.6l2 2 2-2" />
    </>
  ),
  issue: (
    <>
      <circle cx="8" cy="8" r="5.7" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  diff: (
    <>
      <path d="M4.5 2.8v7.4M2 5.3h5" />
      <path d="M9.5 11.2h4.5" />
      <path d="M9.5 14h4.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  undo: (
    <>
      <path d="M3.2 4.2v3.6h3.6" />
      <path d="M3.6 7.6a4.9 4.9 0 1 0 1.4-3.4L3.2 6" />
    </>
  ),
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3 8.6l3.4 3.4L13 4.6" />,
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  'chevron-right': <path d="M6 4l4 4-4 4" />,
  'arrow-up': <path d="M8 13V3M4 7l4-4 4 4" />,
  'arrow-down': <path d="M8 3v10M4 9l4 4 4-4" />,
  sync: (
    <>
      <path d="M2.6 8a5.4 5.4 0 0 1 9.2-3.8l1.6 1.5" />
      <path d="M13.5 2.6v3.3h-3.3" />
      <path d="M13.4 8a5.4 5.4 0 0 1-9.2 3.8l-1.6-1.5" />
      <path d="M2.5 13.4v-3.3h3.3" />
    </>
  ),
  archive: (
    <>
      <path d="M2.2 3.2h11.6v2.7H2.2z" />
      <path d="M3.4 5.9v6.3a1.1 1.1 0 0 0 1.1 1.1h7a1.1 1.1 0 0 0 1.1-1.1V5.9" />
      <path d="M6.4 9h3.2" />
    </>
  ),
  folder: (
    <path d="M2 4.4A1.4 1.4 0 0 1 3.4 3h3l1.6 1.8h4.6A1.4 1.4 0 0 1 14 6.2v5.4a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.6z" />
  ),
  'folder-tree': (
    <>
      <path d="M2 3.3A1.3 1.3 0 0 1 3.3 2h2.6l1.5 1.6h3.4A1.3 1.3 0 0 1 12.1 4.9v1.6" />
      <path d="M6 8.4A1.3 1.3 0 0 1 7.3 7.1h5.4A1.3 1.3 0 0 1 14 8.4v4.3a1.3 1.3 0 0 1-1.3 1.3H7.3A1.3 1.3 0 0 1 6 12.7z" />
      <path d="M4 8.6V6.2" />
    </>
  ),
  list: (
    <>
      <path d="M5.6 4H14M5.6 8H14M5.6 12H14" />
      <circle cx="2.9" cy="4" r=".95" fill="currentColor" stroke="none" />
      <circle cx="2.9" cy="8" r=".95" fill="currentColor" stroke="none" />
      <circle cx="2.9" cy="12" r=".95" fill="currentColor" stroke="none" />
    </>
  ),
  eye: (
    <>
      <path d="M1.8 8S4.6 3.9 8 3.9 14.2 8 14.2 8 11.4 12.1 8 12.1 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  comment: (
    <>
      <path d="M2.4 4.2a1.8 1.8 0 0 1 1.8-1.8h7.6a1.8 1.8 0 0 1 1.8 1.8v4.9a1.8 1.8 0 0 1-1.8 1.8H6.9l-3.5 3v-3h-.1a1.8 1.8 0 0 1-.9-1.6z" />
    </>
  ),
  bot: (
    <>
      <rect x="3" y="5.6" width="10" height="7.4" rx="1.8" />
      <circle cx="6" cy="9.1" r=".95" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9.1" r=".95" fill="currentColor" stroke="none" />
      <path d="M8 5.6V3.4" />
      <circle cx="8" cy="2.6" r=".9" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6" />
      <path d="M8 2.2c1.9 1.7 2.9 3.6 2.9 5.8s-1 4.1-2.9 5.8c-1.9-1.7-2.9-3.6-2.9-5.8s1-4.1 2.9-5.8z" />
    </>
  ),
  success: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M5.2 8.3l2 2 3.6-4.2" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.4L14.5 13.2H1.5z" />
      <path d="M8 6.3v3.1" />
      <circle cx="8" cy="11.5" r=".85" fill="currentColor" stroke="none" />
    </>
  ),
  copy: (
    <>
      <rect x="5.6" y="5.6" width="7.9" height="7.9" rx="1.2" />
      <path d="M10.4 5.6V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.5a1.2 1.2 0 0 0 1.2 1.2h1.9" />
    </>
  ),
  external: (
    <>
      <path d="M6.8 3.5H3.5A1.5 1.5 0 0 0 2 5v7.5A1.5 1.5 0 0 0 3.5 14H11a1.5 1.5 0 0 0 1.5-1.5V9.2" />
      <path d="M9.5 2.5h4v4" />
      <path d="M13 3L8 8" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4.2h11" />
      <path d="M5.6 4.2V2.9a1.3 1.3 0 0 1 1.3-1.3h2.2a1.3 1.3 0 0 1 1.3 1.3v1.3" />
      <path d="M4.1 4.2l.6 8.9a1.4 1.4 0 0 0 1.4 1.3h3.8a1.4 1.4 0 0 0 1.4-1.3l.6-8.9" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8V8l2.2 1.6" />
    </>
  ),
  'clock-reverse': (
    <>
      <path d="M3.2 4.4v3.4h3.4" />
      <path d="M2.7 7.8a5.5 5.5 0 1 0 1.6-3.9L2.6 5.6" />
      <path d="M8 5.4V8l2 1.4" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.35 1.35M11.05 11.05l1.35 1.35M12.4 3.6l-1.35 1.35M4.95 11.05L3.6 12.4" />
    </>
  ),
  ban: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M4.2 11.8 11.8 4.2" />
    </>
  ),
  tag: (
    <>
      <path d="M2.2 7.2V2.2h5l6.6 6.6-5 5z" />
      <circle cx="5.2" cy="5.2" r="1" fill="currentColor" stroke="none" />
    </>
  ),
}

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: 'none', verticalAlign: '-2px' }}
    >
      {PATHS[name]}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// FileIcon：文件类型图标（单一文档轮廓路径 × 按扩展名着色）
// GitHub Linguist 语言色的面板级子集；未知扩展名回退到静默灰。
// ---------------------------------------------------------------------------

const FILE_LANG: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', mts: '#3178c6', cts: '#3178c6',
  js: '#b3a24a', mjs: '#b3a24a', cjs: '#b3a24a', jsx: '#b3a24a',
  json: '#cbcb41', jsonc: '#cbcb41',
  md: '#519aba', mdx: '#519aba', txt: '#9aa4ae',
  css: '#a074c4', scss: '#c6538c', less: '#6b7fc4',
  html: '#e37e4f', vue: '#41b883', svelte: '#ff6347',
  py: '#4b8bbe', rs: '#c67c52', go: '#4da6c8', java: '#b07219',
  yml: '#c56060', yaml: '#c56060', toml: '#9c8f7f', ini: '#9c8f7f',
  sh: '#89c777', ps1: '#6b8cc4', bat: '#9aa4ae',
  png: '#bc8cff', jpg: '#bc8cff', jpeg: '#bc8cff', gif: '#bc8cff', svg: '#a074c4', webp: '#bc8cff', ico: '#bc8cff',
  lock: '#cbcb41', gitignore: '#e0823d', env: '#c56060',
}

export function FileIcon({ name, size = 13 }: { name: string; size?: number }): JSX.Element {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : (name.startsWith('.') ? name.slice(1).toLowerCase() : '')
  const color = FILE_LANG[ext] ?? 'var(--gc-muted, #8b949e)'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: 'none', verticalAlign: '-2px' }}
    >
      <path d="M4 1.8h5l3.2 3.2v9.2H4z" />
      <path d="M9 1.8V5h3.2" />
      <path d="M6 8.6h4M6 11h2.6" opacity=".55" />
    </svg>
  )
}
