/**
 * gitcompass — minimal bilingual dictionary. zh default (matches the primary
 * audience), en fallback driven by the harness locale.
 * @module gitcompass/client/i18n
 */

type Dict = Record<string, string>

const zh: Dict = {
  'panel.title': '罗盘',
  'repo.pick': '选择仓库',
  'repo.none': '无 git 仓库（打开一个 git 工作区）',
  'flow.branch': '分支',
  'flow.commit': '提交',
  'flow.push': '推送',
  'flow.pr': 'PR',
  'flow.review': '评审',
  'flow.merge': '合并',
  'flow.prCreate': '创建 PR',
  'tab.changes': '变更',
  'tab.graph': '图谱',
  'tab.prs': 'PR',
  'tab.github': 'GitHub',
  'changes.clean': '工作区干净',
  'changes.staged': '已暂存',
  'changes.unstaged': '未暂存',
  'changes.untracked': '未跟踪',
  'changes.commitMessage': '提交说明…',
  'changes.commit': '提交',
  'changes.stageAll': '暂存全部',
  'changes.push': '推送',
  'changes.pull': '拉取',
  'changes.fetch': '抓取',
  'actions.stage': '暂存',
  'actions.unstage': '取消暂存',
  'graph.current': '当前',
  'prs.empty': '暂无 PR',
  'prs.open': '开放',
  'prs.merged': '已合并',
  'prs.create': '新建 PR',
  'prs.title': '标题',
  'prs.base': '合入',
  'prs.head': '来自',
  'prs.draft': '草稿',
  'prs.createBtn': '创建',
  'prs.merge': '合并',
  'prs.squash': 'Squash 合并',
  'prs.checks': '检查',
  'prs.reviews': '评审',
  'prs.comments': '评论',
  'github.connect': '连接 GitHub',
  'github.connected': '已连接',
  'github.notConnected': '未连接',
  'github.login': '登录账号',
  'github.loginHint': '打开授权页并输入设备码',
  'github.code': '设备码',
  'github.openUrl': '打开授权页',
  'github.polling': '等待授权…',
  'github.pat': '或粘贴 Personal Access Token',
  'github.patBtn': '保存',
  'github.logout': '退出登录',
  'github.scopes': '权限范围',
  'github.repo': '远程仓库',
  'common.loading': '加载中…',
  'common.error': '出错',
  'common.refresh': '刷新',
}

const en: Dict = {
  'panel.title': 'Compass',
  'repo.pick': 'Pick repository',
  'repo.none': 'No git repo (open a git workspace)',
  'flow.branch': 'Branch',
  'flow.commit': 'Commit',
  'flow.push': 'Push',
  'flow.pr': 'PR',
  'flow.review': 'Review',
  'flow.merge': 'Merge',
  'flow.prCreate': 'Create PR',
  'tab.changes': 'Changes',
  'tab.graph': 'Graph',
  'tab.prs': 'PRs',
  'tab.github': 'GitHub',
  'changes.clean': 'Working tree clean',
  'changes.staged': 'Staged',
  'changes.unstaged': 'Unstaged',
  'changes.untracked': 'Untracked',
  'changes.commitMessage': 'Commit message…',
  'changes.commit': 'Commit',
  'changes.stageAll': 'Stage all',
  'changes.push': 'Push',
  'changes.pull': 'Pull',
  'changes.fetch': 'Fetch',
  'actions.stage': 'Stage',
  'actions.unstage': 'Unstage',
  'graph.current': 'current',
  'prs.empty': 'No PRs',
  'prs.open': 'Open',
  'prs.merged': 'Merged',
  'prs.create': 'New PR',
  'prs.title': 'Title',
  'prs.base': 'into',
  'prs.head': 'from',
  'prs.draft': 'draft',
  'prs.createBtn': 'Create',
  'prs.merge': 'Merge',
  'prs.squash': 'Squash merge',
  'prs.checks': 'Checks',
  'prs.reviews': 'Reviews',
  'prs.comments': 'Comments',
  'github.connect': 'Connect GitHub',
  'github.connected': 'Connected',
  'github.notConnected': 'Not connected',
  'github.login': 'Sign in',
  'github.loginHint': 'Open the URL and enter the device code',
  'github.code': 'Device code',
  'github.openUrl': 'Open authorization page',
  'github.polling': 'Waiting for authorization…',
  'github.pat': 'or paste a Personal Access Token',
  'github.patBtn': 'Save',
  'github.logout': 'Sign out',
  'github.scopes': 'Scopes',
  'github.repo': 'Remote repo',
  'common.loading': 'Loading…',
  'common.error': 'Error',
  'common.refresh': 'Refresh',
}

let dict: Dict = zh

export function initI18n(locale: { getLocale(): { active: string }; subscribe(fn: () => void): () => void }): void {
  const apply = (): void => {
    try {
      dict = locale.getLocale().active.toLowerCase().startsWith('en') ? en : zh
    } catch {
      dict = zh
    }
  }
  apply()
  locale.subscribe(apply)
}

export function t(key: string): string {
  return dict[key] ?? key
}
