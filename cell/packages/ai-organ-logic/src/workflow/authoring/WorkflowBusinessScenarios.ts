export type WorkflowBusinessScenarioId =
  | "direct"
  | "research"
  | "local-digest"
  | "fan-out-reduce"
  | "routing"
  | "adversarial-verify"
  | "loop-until-dry"
  | "generate-and-filter"
  | "tournament"
  | "approval-process"
  | "generic"

export type WorkflowBusinessScenario = {
  id: WorkflowBusinessScenarioId
  title: string
  purpose: string
  topology: readonly string[]
  completion: string
}

const DIRECT_SCENARIO: WorkflowBusinessScenario = Object.freeze({
  id: "direct",
  title: "Direct work",
  purpose: "Complete a small task in the current actor without creating durable orchestration.",
  topology: Object.freeze(["perform the requested work"]),
  completion: "The requested result is delivered.",
})

export const WORKFLOW_BUSINESS_SCENARIOS: readonly WorkflowBusinessScenario[] = Object.freeze([
  {
    id: "research",
    title: "Evidence-backed research",
    purpose: "Find real sources, read them independently, then synthesize a cited deliverable.",
    topology: ["find sources", "read sources independently", "synthesize from collected evidence"],
    completion: "A sourced business report is delivered.",
  },
  {
    id: "local-digest",
    title: "Local material digest",
    purpose: "Read bounded local materials, extract facts, deduplicate them and produce a faithful artifact.",
    topology: ["import exact materials", "extract facts", "deduplicate and synthesize", "produce bounded output"],
    completion: "The output can be traced to exact input material revisions.",
  },
  {
    id: "fan-out-reduce",
    title: "Parallel perspectives and synthesis",
    purpose: "Apply independent perspectives or processors, then combine their results.",
    topology: ["fan out independent work", "collect results", "reduce into one result"],
    completion: "All relevant independent results are represented in one deliverable.",
  },
  {
    id: "routing",
    title: "Classify and route",
    purpose: "Classify an item and dispatch only the matching business handler.",
    topology: ["classify", "select a branch", "run the matching handler"],
    completion: "The selected handler returns the business result.",
  },
  {
    id: "adversarial-verify",
    title: "Adversarial verification",
    purpose: "Generate candidates, challenge them independently and keep only supported results.",
    topology: ["generate candidates", "challenge independently", "filter by evidence"],
    completion: "The deliverable distinguishes survivors from rejected candidates.",
  },
  {
    id: "loop-until-dry",
    title: "Iterate until no new findings",
    purpose: "Repeat bounded discovery or repair until a round produces no new work.",
    topology: ["perform a round", "compare with prior findings", "repeat or stop"],
    completion: "The stop condition and accumulated result are recorded.",
  },
  {
    id: "generate-and-filter",
    title: "Generate and filter",
    purpose: "Generate diverse candidates, remove duplicates and rank against a rubric.",
    topology: ["generate through distinct lenses", "deduplicate", "score and keep the best"],
    completion: "A ranked, justified shortlist is delivered.",
  },
  {
    id: "tournament",
    title: "Compete and judge",
    purpose: "Have independent strategies solve the same problem and judge them consistently.",
    topology: ["produce distinct solutions", "compare against one rubric", "select a winner"],
    completion: "The winning result and reason are delivered.",
  },
  {
    id: "approval-process",
    title: "Durable approval process",
    purpose: "Prepare business evidence, wait for an accountable decision and follow the selected outcome.",
    topology: ["prepare evidence", "request approval", "wait durably", "continue, revise or stop"],
    completion: "The decision and resulting action are recorded.",
  },
  {
    id: "generic",
    title: "Generic durable composition",
    purpose: "Compose the smallest durable sequence that directly performs the business work.",
    topology: ["perform business steps", "carry results forward", "deliver the requested artifact"],
    completion: "The original business goal is satisfied.",
  },
].map((item) => Object.freeze({ ...item, topology: Object.freeze(item.topology) })))

const SCENARIO_BY_ID = new Map(WORKFLOW_BUSINESS_SCENARIOS.map((scenario) => [scenario.id, scenario]))

export function getWorkflowBusinessScenario(id: WorkflowBusinessScenarioId): WorkflowBusinessScenario {
  if (id === "direct") return DIRECT_SCENARIO
  const scenario = SCENARIO_BY_ID.get(id)
  if (!scenario) throw new Error(`Unknown workflow business scenario: ${id}`)
  return scenario
}
