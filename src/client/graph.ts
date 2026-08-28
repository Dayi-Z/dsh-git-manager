/**
 * gitcompass — commit DAG layout: lane assignment (GitLens/gitk-style columns).
 * Adapted from dsh-git-panel's battle-tested implementation.
 * @module gitcompass/client/graph
 */

import type { GraphCommit } from '../core/types.ts'

export interface LayoutCommit extends GraphCommit {
  /** Row index, 0 = newest (top). */
  row: number
  /** Lane index (0-based). */
  lane: number
}

/**
 * Assign lane positions to commits. Input is git log --date-order (newest first).
 * Processing runs oldest-to-newest: a commit inherits the lane of a child that
 * references it; otherwise it occupies an empty lane or opens a new one.
 */
export function layoutGraph(commits: GraphCommit[]): LayoutCommit[] {
  const order = commits.map((commit, index) => ({ commit, index })).reverse() // oldest first
  const lanes: Array<string | null> = []
  const placed = new Map<string, LayoutCommit>()

  for (const { commit, index } of order) {
    const row = commits.length - 1 - index
    let lane = lanes.findIndex((owner) => owner !== null && commit.parents.includes(owner))
    if (lane === -1) {
      lane = lanes.findIndex((owner) => owner === null)
      if (lane === -1) {
        lanes.push(null)
        lane = lanes.length - 1
      }
    }
    const layout: LayoutCommit = { ...commit, row, lane }
    placed.set(commit.sha, layout)
    lanes[lane] = commit.sha
  }
  return commits.map((commit) => placed.get(commit.sha)!)
}
