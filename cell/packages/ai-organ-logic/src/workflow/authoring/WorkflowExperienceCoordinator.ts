import {
  getWorkflowBusinessScenario,
  type WorkflowBusinessScenario,
  type WorkflowBusinessScenarioId,
} from "./WorkflowBusinessScenarios"

export type WorkflowExperienceRoute = "direct" | "ai-ctrl" | "ai-data" | "composite"
export type WorkflowExperienceOperation = "auto" | "create" | "edit" | "run" | "continue"
export type WorkflowJourneyStage =
  | "handle-directly"
  | "select-context"
  | "author-and-prove"
  | "await-publication-confirmation"
  | "publish"
  | "infer-inputs-and-materials"
  | "prepare-instance"
  | "preview-execution"
  | "await-execution-confirmation"
  | "execute"
  | "report-business-result"

export type WorkflowExperiencePlan = {
  kind: "workflow.experiencePlan"
  request: string
  operation: WorkflowExperienceOperation
  workflowRef?: string
  route: WorkflowExperienceRoute
  routeSource: "inferred" | "expert-override"
  scenario: WorkflowBusinessScenario
  scenarioSource: "inferred" | "expert-override"
  userRequiredFields: readonly ["request"]
  authorization: {
    publication: "explicit" | "missing"
    execution: "explicit" | "missing"
  }
  journey: readonly WorkflowJourneyStage[]
  evidence: readonly string[]
  expert: boolean
}

export type WorkflowExperienceInput = {
  request: string
  operation?: WorkflowExperienceOperation
  workflowRef?: string
  publish?: boolean
  execute?: boolean
  route?: WorkflowExperienceRoute
  scenario?: WorkflowBusinessScenarioId
  expert?: boolean
}

const has = (value: string, pattern: RegExp): boolean => pattern.test(value)

function inferScenario(request: string): WorkflowBusinessScenarioId {
  if (has(request, /workspace|本地(?:文件|目录|资料|材料)|目录里的|文件里的|日志|访谈记录|输入材料/iu)) return "local-digest"
  if (has(request, /工单|分流|分类.*(?:对应|交给)|判断.*(?:对应|交给)|route/iu)) return "routing"
  if (has(request, /反驳|质疑|对抗|独立审查|经得住/iu)) return "adversarial-verify"
  if (has(request, /直到.*(?:没有|无)新增|连续.*(?:没有|无)新增|循环.*直到|穷尽|until/iu)) return "loop-until-dry"
  if (has(request, /(?:生成|提出).*(?:去重|评分|筛选|最好|top)|创意.*(?:评分|筛选)/iu)) return "generate-and-filter"
  if (has(request, /裁判|锦标赛|不同策略.*(?:最佳|选出)|比较.*最佳方案/iu)) return "tournament"
  if (has(request, /批准|审批|负责人.*(?:确认|决定)|等待.*(?:确认|审核|决定)|驳回/iu)) return "approval-process"
  if (has(request, /调研|研究|真实(?:公共)?来源|公共来源|联网|搜索.*报告|带引用|https?:\/\//iu)) return "research"
  if (has(request, /并行|分别|多个视角|多角度|五个|若干.*(?:合并|综合)|扇出/iu)) return "fan-out-reduce"
  return "generic"
}

function durableSignals(request: string): string[] {
  const signals: string[] = []
  if (has(request, /workflow|工作流|流程|可复用|以后.*运行|长期|恢复|重放|resume/iu)) signals.push("durable-process")
  if (has(request, /并行|分别|多个|五个|若干|合并|汇总|去重|评分|逐份|几位专家|不同策略|裁判/iu)) signals.push("data-topology")
  if (has(request, /批准|审批|等待|驳回|分支|对应专家|直到|循环|重新评审/iu)) signals.push("control-topology")
  if (has(request, /调研|真实(?:公共)?来源|公共来源|https?:\/\/|本地|workspace|文件|材料|访谈记录/iu)) signals.push("external-or-material-input")
  if (has(request, /先.+再|然后|最后|之后/iu)) signals.push("multi-stage")
  return signals
}

function inferRoute(request: string, scenarioId: WorkflowBusinessScenarioId, signals: readonly string[]): WorkflowExperienceRoute {
  if (signals.length === 0) return "direct"
  if (scenarioId === "routing" || scenarioId === "loop-until-dry") return "ai-ctrl"
  if (scenarioId === "approval-process") {
    return signals.includes("data-topology") || signals.includes("external-or-material-input") ? "composite" : "ai-ctrl"
  }
  if (["research", "local-digest", "fan-out-reduce", "adversarial-verify", "generate-and-filter", "tournament"].includes(scenarioId)) {
    return signals.includes("control-topology") ? "composite" : "ai-data"
  }
  if (signals.includes("control-topology") && signals.includes("data-topology")) return "composite"
  if (signals.includes("control-topology")) return "ai-ctrl"
  if (signals.includes("data-topology") || signals.includes("external-or-material-input")) return "ai-data"
  return "ai-ctrl"
}

function makeJourney(route: WorkflowExperienceRoute, publish: boolean, execute: boolean): readonly WorkflowJourneyStage[] {
  if (route === "direct") return Object.freeze(["handle-directly"])
  const stages: WorkflowJourneyStage[] = ["select-context", "author-and-prove"]
  if (!publish) return Object.freeze([...stages, "await-publication-confirmation"])
  stages.push("publish", "infer-inputs-and-materials", "prepare-instance", "preview-execution")
  if (!execute) return Object.freeze([...stages, "await-execution-confirmation"])
  return Object.freeze([...stages, "execute", "report-business-result"])
}

export function planWorkflowExperience(input: WorkflowExperienceInput): WorkflowExperiencePlan {
  const request = input.request?.trim()
  if (!request) throw new Error("Workflow experience requires an ordinary-language business request")
  const signals = durableSignals(request)
  const inferredScenario = inferScenario(request)
  const inferredRoute = inferRoute(request, inferredScenario, signals)
  const route = input.route ?? inferredRoute
  const scenarioId = route === "direct" ? "direct" : (input.scenario ?? inferredScenario)
  const publication = input.publish === true ? "explicit" : "missing"
  const execution = input.execute === true ? "explicit" : "missing"
  return Object.freeze({
    kind: "workflow.experiencePlan" as const,
    request,
    operation: input.operation ?? "auto",
    ...(input.workflowRef?.trim() ? { workflowRef: input.workflowRef.trim() } : {}),
    route,
    routeSource: input.route ? "expert-override" : "inferred",
    scenario: getWorkflowBusinessScenario(scenarioId),
    scenarioSource: input.scenario ? "expert-override" : "inferred",
    userRequiredFields: Object.freeze(["request"] as const),
    authorization: Object.freeze({ publication, execution }),
    journey: makeJourney(route, input.publish === true, input.execute === true),
    evidence: Object.freeze(signals),
    expert: input.expert === true,
  })
}

export type WorkflowBusinessStateInput = {
  status: "direct" | "draft" | "ready" | "running" | "waiting" | "completed" | "failed"
  purpose: string
  summary: string
  nextAction?: string
  result?: unknown
  internal?: Record<string, unknown>
}

export function projectWorkflowBusinessState(input: WorkflowBusinessStateInput, expert = false): Record<string, unknown> {
  return {
    status: input.status,
    purpose: input.purpose,
    summary: input.summary,
    ...(input.nextAction ? { nextAction: input.nextAction } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(expert && input.internal ? { internal: input.internal } : {}),
  }
}
