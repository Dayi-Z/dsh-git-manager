/**
 * dsh-git-manager — 文件活动追踪的实测（脚本，不进包）。
 *
 * 直接跑 TS 源码（Node 原生类型擦除），并把 USERPROFILE 指到临时目录，
 * 这样 repo-store 写的是**临时货架**，绝不碰你真实的
 * ~/.dsh/storages/dsh-git-manager/repos.json。
 *
 *   node scripts/test-activity.mjs
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = join(process.env.TEMP ?? '/tmp', 'gitm-activity-test-' + Date.now());
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
mkdirSync(HOME, { recursive: true });

const { startActivityTracker } = await import('../src/host/activity.ts');
const { shelfList, shelfAddAuto, shelfAdd, AUTO_SHELF_MAX } = await import('../src/host/repo-store.ts');

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined && !cond ? '  → ' + JSON.stringify(extra) : ''));
  if (!cond) failures++;
};

// ── 造几个假仓库：tmp/nested/inner 有 .git，tmp/plain 没有 ──────────────
const root = join(HOME, 'repos');
const inner = join(root, 'nested', 'inner');
const innerSrc = join(inner, 'src');
const plain = join(root, 'plain');
mkdirSync(join(inner, '.git'), { recursive: true });
mkdirSync(innerSrc, { recursive: true });
mkdirSync(plain, { recursive: true });
writeFileSync(join(innerSrc, 'a.ts'), 'export const a = 1\n');
writeFileSync(join(plain, 'x.txt'), 'hello\n');

function makeCtx(workspaces = [], config = undefined) {
  const handlers = {};
  return {
    ctx: { on: (name, fn) => { handlers[name] = fn; }, workspaceRegistry: { list: () => workspaces }, ...(config ? { config } : {}) },
    fire: async (exec) => handlers['tools/execute'](exec, async () => 'DISPATCHED'),
  };
}
const events = [];
const bus = { emit: (type, data) => events.push({ type, data }) };

// ── A: 编辑嵌套仓库里的文件 → 自动收录仓库根 + 快照 ────────────────────
{
  const h = makeCtx();
  const tracker = startActivityTracker(h.ctx, bus, () => {});
  const ret = await h.fire({ name: 'edit', arguments: { file_path: join(innerSrc, 'a.ts') } });
  check('A1 工具调用照常继续（next 被调用）', ret === 'DISPATCHED', ret);
  check('A2 嵌套仓库根被自动收录', shelfList().some((e) => e.path === inner), shelfList().map((e) => e.path));
  check('A3 自动条目带 auto 标记', shelfList().find((e) => e.path === inner)?.auto === true, shelfList().find((e) => e.path === inner));
  const snap = tracker.snapshot();
  check('A4 快照记录工具与仓库', snap?.tool === 'edit' && snap?.repo === inner, snap);
  check('A5 快照的 dir 是文件所在目录', snap?.dir === innerSrc, snap?.dir);
  check('A6 发了一条 repo:auto-added 事件', events.some((e) => e.type === 'repo:auto-added' && e.data.path === inner), events);
}

// ── B: 同一个仓库再来一次 → 不重复收录 ─────────────────────────────────
{
  events.length = 0;
  const h = makeCtx();
  const tracker = startActivityTracker(h.ctx, bus, () => {});
  await h.fire({ name: 'write', arguments: { file_path: join(innerSrc, 'b.ts') } });
  check('B1 已收录的仓库不重复添加', !events.some((e) => e.type === 'repo:auto-added'), events);
  check('B2 但快照仍然更新', tracker.snapshot()?.path === join(innerSrc, 'b.ts'), tracker.snapshot());
  check('B3 货架里该仓库仍只有一条', shelfList().filter((e) => e.path === inner).length === 1, shelfList().length);

  // B4：**尚不存在**的新文件（write 新建）——观测发生在工具执行之前，
  // 所以这条路径在磁盘上还没有，仍然必须能定位到仓库。
  const fresh = join(innerSrc, 'brand-new.ts');
  const h2 = makeCtx();
  const t2 = startActivityTracker(h2.ctx, bus, () => {});
  await h2.fire({ name: 'write', arguments: { file_path: fresh } });
  check('B4 新文件的快照仍能定位仓库', t2.snapshot()?.repo === inner, t2.snapshot());
  check('B5 新文件的 dir 落到最近的存在目录', t2.snapshot()?.dir === innerSrc, t2.snapshot()?.dir);
}

// ── C: 不在任何仓库里的文件 → 只记录，不收录 ────────────────────────────
{
  events.length = 0;
  const h = makeCtx();
  const tracker = startActivityTracker(h.ctx, bus, () => {});
  const before = shelfList().length;
  await h.fire({ name: 'read', arguments: { file_path: join(plain, 'x.txt') } });
  check('C1 仓库外的文件 repo 为 null', tracker.snapshot()?.repo === null, tracker.snapshot());
  check('C2 不收录、不发事件', shelfList().length === before && events.length === 0, { n: shelfList().length, ev: events.length });
}

// ── D: 已注册工作区 → 不重复收录 ────────────────────────────────────────
{
  const other = join(root, 'nested');           // 也算一个"工作区"（有 .git 的父目录）
  mkdirSync(join(other, '.git'), { recursive: true });
  writeFileSync(join(other, 'top.txt'), 'x\n');
  events.length = 0;
  const h = makeCtx([{ path: other }]);
  startActivityTracker(h.ctx, bus, () => {});
  await h.fire({ name: 'edit', arguments: { file_path: join(other, 'top.txt') } });
  check('D1 已注册工作区不被重复收录', !shelfList().some((e) => e.path === other), shelfList().map((e) => e.path));
  check('D2 也不发事件', events.length === 0, events);
}

// ── E: 自动条目上限（手动条目永不淘汰）─────────────────────────────────
{
  shelfAdd({ path: join(root, 'manual-repo'), title: 'manual' });
  for (let i = 0; i < AUTO_SHELF_MAX + 5; i++) shelfAddAuto(join(root, 'auto', 'r' + i), 'r' + i);
  const list = shelfList();
  const autos = list.filter((e) => e.auto === true);
  check('E1 自动条目被裁到上限', autos.length === AUTO_SHELF_MAX, autos.length);
  check('E2 手动条目幸存', list.some((e) => e.title === 'manual'), list.map((e) => e.title));
  check('E3 淘汰的是最旧的自动条目', !autos.some((e) => e.title === 'r0'), autos.slice(0, 3).map((e) => e.title));
  check('E4 最新的自动条目还在', autos.some((e) => e.title === 'r' + (AUTO_SHELF_MAX + 4)));
}

// ── F: 关掉自动收录 → 仍然记录快照，但不进货架 ──────────────────────────
{
  const g = join(root, 'gated');
  mkdirSync(join(g, '.git'), { recursive: true });
  writeFileSync(join(g, 'c.ts'), 'x\n');
  const h = makeCtx([], { autoRegisterRepos: false });
  const tracker = startActivityTracker(h.ctx, bus, () => {});
  await h.fire({ name: 'edit', arguments: { file_path: join(g, 'c.ts') } });
  check('F1 autoRegisterRepos:false → 不收录', !shelfList().some((e) => e.path === g), shelfList().map((e) => e.path));
  check('F2 但仍然记录"正在修改"', tracker.snapshot()?.repo === g, tracker.snapshot());
}

// ── G: 没有路径参数的工具调用 → 完全不动 ────────────────────────────────
{
  const h = makeCtx();
  const tracker = startActivityTracker(h.ctx, bus, () => {});
  await h.fire({ name: 'git_status', arguments: { workspace: inner } });
  check('G1 无路径键的参数不产生快照', tracker.snapshot() === null, tracker.snapshot());
}

// ── H: 落盘确实是隔离的（没碰真实货架）─────────────────────────────────
{
  const file = join(HOME, '.dsh', 'storages', 'dsh-git-manager', 'repos.json');
  check('H1 写入的是临时 home 下的货架', existsSync(file), file);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  check('H2 临时货架内容可解析', Array.isArray(parsed) && parsed.length > 0, parsed.length);
}

rmSync(HOME, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'ALL ACTIVITY CHECKS PASSED' : failures + ' CHECKS FAILED'));
process.exit(failures === 0 ? 0 : 1);
