// 操作反馈总线：面板任意处的成功/失败结果汇聚到顶部横幅。
// 单槽（最新覆盖旧）——Operate 模式下状态必须可见，但不得堆积噪音。
export type OpFeedback = { kind: 'ok' | 'err'; title: string; detail?: string; ts: number }

type Listener = (f: OpFeedback) => void

let listener: Listener | null = null

export function onOpFeedback(l: Listener): () => void {
  listener = l
  return () => { if (listener === l) listener = null }
}

export function report(kind: 'ok' | 'err', title: string, detail?: string): void {
  listener?.({ kind, title, detail, ts: Date.now() })
}

export function reportError(title: string, e: unknown): void {
  report('err', title, e instanceof Error ? e.message : String(e))
}
