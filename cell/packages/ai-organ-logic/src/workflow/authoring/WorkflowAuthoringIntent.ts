export type WorkflowAuthoringIntent = {
  originalRequest: string
  durableSignals: string[]
  workflowWarranted: boolean
  businessPayload?: string
  businessPayloadSource: "quoted-contiguous-span" | "whole-request" | "ambiguous"
  publicationRequested: boolean
  publicationForbidden: boolean
  executionRequested: boolean
  executionForbidden: boolean
}

const DURABLE_SIGNALS: Array<[string, RegExp]> = [
  ["multiple-phases", /多阶段|多个步骤|依次|然后|之后|汇总后|直到|phase|steps?|then|after/iu],
  ["branch-or-loop", /分支|循环|重试|条件|否则|branch|loop|retry|if\b|until/iu],
  ["human-approval", /人工|审批|确认|审核|human|approval|review/iu],
  ["async-wait", /等待|异步|稍后|回调|wait|async|callback/iu],
  ["recovery", /恢复|续接|回放|重放|resume|recover|replay/iu],
  ["workflow-explicit", /工作流|流程|workflow/iu],
]

const AUTHORING_MARKERS = /设计|创建|编写|修改|编辑|验证|发布|安装|运行|执行|说明|workflow|工作流|流程|dry[- ]?run|publish|validate/iu
const PUBLICATION = /发布|publish/iu
const EXECUTION = /运行|执行|启动|run|execute|start/iu
const NO_PUBLICATION = /不要发布|不发布|只创建|do not publish|without publishing/iu
const NO_EXECUTION = /不要运行|不要执行|不要启动|不运行|不执行|do not run|do not execute|without running/iu

function quotedSpans(source: string): string[] {
  const spans: string[] = []
  const patterns = [/“([^”]+)”/gu, /「([^」]+)」/gu, /"([^"]+)"/gu, /'([^']+)'/gu]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) spans.push(match[1]!)
  }
  return spans
}

export function analyzeWorkflowAuthoringIntent(request: string): WorkflowAuthoringIntent {
  const originalRequest = request.trim()
  const durableSignals = DURABLE_SIGNALS.filter(([, pattern]) => pattern.test(originalRequest)).map(([name]) => name)
  const quoted = quotedSpans(originalRequest)
  let businessPayload: string | undefined
  let businessPayloadSource: WorkflowAuthoringIntent["businessPayloadSource"]
  if (quoted.length === 1) {
    businessPayload = quoted[0]
    businessPayloadSource = "quoted-contiguous-span"
  } else if (quoted.length > 1) {
    businessPayloadSource = "ambiguous"
  } else if (!AUTHORING_MARKERS.test(originalRequest)) {
    businessPayload = originalRequest
    businessPayloadSource = "whole-request"
  } else {
    businessPayloadSource = "ambiguous"
  }
  return {
    originalRequest,
    durableSignals,
    workflowWarranted: durableSignals.length > 0,
    ...(businessPayload === undefined ? {} : { businessPayload }),
    businessPayloadSource,
    publicationRequested: PUBLICATION.test(originalRequest) && !NO_PUBLICATION.test(originalRequest),
    publicationForbidden: NO_PUBLICATION.test(originalRequest),
    executionRequested: EXECUTION.test(originalRequest) && !NO_EXECUTION.test(originalRequest),
    executionForbidden: NO_EXECUTION.test(originalRequest),
  }
}
