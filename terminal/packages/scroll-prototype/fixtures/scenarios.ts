import { fixtureRange, type FixtureRow } from "./data"

export interface FixturePage {
  request: "latest" | "earlier" | "later"
  boundary: string | null
  rows: FixtureRow[]
  before: string | null
  after: string | null
}

export interface FixtureRevision {
  state: "collapsed" | "expanded" | "streaming" | "complete"
  row: FixtureRow
}

export interface FixtureFailure {
  kind: "stale" | "rejected" | "timeout" | "budget" | "cancelled" | "empty-no-progress"
  requestId: string
  boundary: string
  returnedBoundary: string
  rows: FixtureRow[]
}

// Declarative inputs for a future test driver; these do not implement paging,
// cancellation, timing, viewport policy, or any production protocol.
export function fixtureScenario(): {
  pages: FixturePage[]
  revisions: FixtureRevision[]
  failures: FixtureFailure[]
} {
  const options = { sourceCount: 120, tailLines: 120, shape: "chat" as const }
  const tail = fixtureRange(80, 40, options)
  const middle = fixtureRange(40, 40, options)
  const first = fixtureRange(0, 40, options)
  const changing = tail[39]
  const revision = (number: number, lines: number, state: FixtureRevision["state"]): FixtureRevision => ({
    state,
    row: {
      ...changing,
      revision: number,
      text: `# Card 119\n${Array.from({ length: lines }, (_, line) => `line-${line} 中文代码 content`).join("\n")}\nEND-119`,
    },
  })
  return {
    pages: [
      { request: "latest", boundary: null, rows: tail, before: "fixture-middle", after: null },
      { request: "earlier", boundary: "fixture-middle", rows: middle, before: "fixture-first", after: "fixture-tail" },
      { request: "earlier", boundary: "fixture-first", rows: first, before: null, after: "fixture-middle" },
      { request: "later", boundary: "fixture-middle", rows: fixtureRange(40, 40, options), before: "fixture-first", after: "fixture-tail" },
      { request: "later", boundary: "fixture-tail", rows: fixtureRange(80, 40, options), before: "fixture-middle", after: null },
    ],
    revisions: [
      revision(1, 2, "collapsed"),
      revision(2, 120, "expanded"),
      revision(3, 121, "streaming"),
      revision(4, 800, "streaming"),
      revision(5, 800, "complete"),
    ],
    failures: (["stale", "rejected", "timeout", "budget", "cancelled", "empty-no-progress"] as const).map((kind) => ({
      kind,
      requestId: `fixture-${kind}`,
      boundary: "fixture-middle",
      returnedBoundary: "fixture-middle",
      rows: [],
    })),
  }
}
