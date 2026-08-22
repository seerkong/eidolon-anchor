import { describe, expect, it } from "bun:test"

import corpus from "./fixtures/workflow-human-product-corpus.json"
import { assembleWorkflowFulfillmentPrompt } from "../../src/workflow"
import { WORKFLOW_NATIVE_TOOL_NAMES, buildWorkflowNativeToolDefs } from "../../src/workflow/tools"
import { normalizeWorkflowFulfillmentContinuation } from "../../src/workflow/tools/WorkflowFulfill/OuterTypes"
import {
  applyAiWorkflowStageSystemContext,
  applyAiWorkflowStageToolPolicy,
} from "../../src/workflow/tools/WorkflowLoadStageContext"
import { BUILTIN_CODING_AGENT_CONFIGS } from "@cell/mod-ai-coding/agent"
import { resolveProviderToolsetForActor } from "../../src/exec/AiAgentExecutor"

describe("workflow human product experience", () => {
  it("preserves a business-language corpus for model-owned semantic routing", () => {
    for (const entry of corpus) {
      const prompt = assembleWorkflowFulfillmentPrompt({ request: entry.request })
      expect(prompt).toContain(entry.request)
      expect(prompt).not.toContain(`"route": "${entry.route}"`)
      expect(prompt).not.toContain(`"scenario": "${entry.scenario}"`)
    }
    expect(JSON.stringify(corpus)).not.toMatch(/AICtrlWorkflow|AIDataWorkflow|node_id|reuse_policy|manifest\.xnl|resource:\/\//)
  })

  it("records independent publication/execution authorization without interpreting the request", () => {
    const prompt = assembleWorkflowFulfillmentPrompt({
      request: "并行调研三个方向，合并结果后等待负责人批准。",
      publish: true,
      execute: false,
    })
    expect(prompt).toContain('"publication": true')
    expect(prompt).toContain('"execution": false')
    expect(prompt).not.toMatch(/approval-process|composite/)
  })

  it("passes only the current structured invocation instead of building workflow-specific history", () => {
    const prompt = assembleWorkflowFulfillmentPrompt({
      request: "Proceed with the confirmed recommendation and publish it.",
      publish: false,
      execute: false,
    })
    expect(prompt).not.toContain("eidolon.aiWorkflowPriorConversation")
    expect(prompt).toContain('"publication": false')
    expect(prompt).toContain('"execution": false')
  })

  it("carries exact lifecycle continuation as a closed structured payload", () => {
    const continuation = normalizeWorkflowFulfillmentContinuation({
      kind: "authoring",
      authoring_session_id: "session-1",
      expected_revision: "sha256:working",
      proof_receipt_ids: ["proof-1", "proof-2"],
    })
    const prompt = assembleWorkflowFulfillmentPrompt({
      request: "Publish the prepared revision without running it.",
      publish: true,
      execute: false,
      continuation,
    })

    expect(prompt).toContain('"kind": "authoring"')
    expect(prompt).toContain('"authoring_session_id": "session-1"')
    expect(prompt).toContain('"proof_receipt_ids": [')
    expect(prompt).not.toContain("eidolon.aiWorkflowPriorConversation")
    expect(() => normalizeWorkflowFulfillmentContinuation({
      kind: "authoring",
      authoring_session_id: "session-1",
      expected_revision: "sha256:working",
      proof_receipt_ids: ["proof-1"],
      publication_receipt_id: "not-allowed",
    })).toThrow("WORKFLOW_FULFILL_CONTINUATION_FIELD_UNSUPPORTED")
  })

  it("rejects non-canonical continuation arrays at programmatic and JSON boundaries", () => {
    const continuation = (proofReceiptIds: unknown) => ({
      kind: "authoring",
      authoring_session_id: "session-1",
      expected_revision: "sha256:working",
      proof_receipt_ids: proofReceiptIds,
    })
    const sparse = new Array<string>(5)
    sparse[0] = "proof-1"
    sparse[2] = "proof-2"
    sparse[3] = "proof-3"
    sparse[4] = "proof-4"

    let accessorRead = false
    const accessor = ["proof-1"]
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        accessorRead = true
        return "proof-1"
      },
    })
    const symbolField = ["proof-1"] as string[] & { [key: symbol]: boolean }
    symbolField[Symbol("continuation-array-field")] = true
    const extraField = ["proof-1"] as string[] & { note?: string }
    extraField.note = "not part of the array contract"
    const nonEnumerableIndex = ["proof-1"]
    Object.defineProperty(nonEnumerableIndex, "0", {
      enumerable: false,
      value: "proof-1",
    })

    for (const value of [sparse, accessor, symbolField, extraField, nonEnumerableIndex]) {
      expect(() => normalizeWorkflowFulfillmentContinuation(continuation(value)))
        .toThrow("WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID")
    }
    expect(accessorRead).toBe(false)

    for (const source of [
      '{"kind":"authoring","authoring_session_id":"session-1","expected_revision":"sha256:working","proof_receipt_ids":["proof-1",null]}',
      '{"kind":"authoring","authoring_session_id":"session-1","expected_revision":"sha256:working","proof_receipt_ids":["proof-1","proof-1"]}',
    ]) {
      expect(() => normalizeWorkflowFulfillmentContinuation(JSON.parse(source)))
        .toThrow("WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID")
    }
  })

  it("rejects non-canonical continuation objects without reading inherited values", () => {
    const fields = {
      kind: "authoring",
      authoring_session_id: "session-1",
      expected_revision: "sha256:working",
      proof_receipt_ids: ["proof-1"],
    }
    let inheritedGetterRead = false
    const inherited = Object.create(null)
    Object.defineProperties(inherited, {
      kind: {
        enumerable: true,
        get() {
          inheritedGetterRead = true
          return "authoring"
        },
      },
      authoring_session_id: { enumerable: true, value: "session-1" },
      expected_revision: { enumerable: true, value: "sha256:working" },
      proof_receipt_ids: { enumerable: true, value: ["proof-1"] },
    })
    const inheritedOnly = {}
    Object.defineProperty(inheritedOnly, "__proto__", {
      enumerable: true,
      value: inherited,
    })
    expect(() => normalizeWorkflowFulfillmentContinuation(inheritedOnly))
      .toThrow("WORKFLOW_FULFILL_CONTINUATION")
    expect(inheritedGetterRead).toBe(false)

    expect(() => normalizeWorkflowFulfillmentContinuation(JSON.parse(
      '{"__proto__":{"kind":"authoring","authoring_session_id":"session-1","expected_revision":"sha256:working","proof_receipt_ids":["proof-1"]}}',
    ))).toThrow("WORKFLOW_FULFILL_CONTINUATION")

    const nonEnumerable = { ...fields }
    Object.defineProperty(nonEnumerable, "kind", {
      enumerable: false,
      value: "authoring",
    })
    expect(() => normalizeWorkflowFulfillmentContinuation(nonEnumerable))
      .toThrow("WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID")

    const nonPlain = Object.assign(Object.create({ inherited: true }), fields)
    expect(() => normalizeWorkflowFulfillmentContinuation(nonPlain))
      .toThrow("WORKFLOW_FULFILL_CONTINUATION_INVALID")

    let accessorRead = false
    const accessor = { ...fields }
    Object.defineProperty(accessor, "kind", {
      enumerable: true,
      get() {
        accessorRead = true
        return "authoring"
      },
    })
    expect(() => normalizeWorkflowFulfillmentContinuation(accessor))
      .toThrow("WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID")
    expect(accessorRead).toBe(false)

    const symbolField = { ...fields, [Symbol("continuation-field")]: true }
    expect(() => normalizeWorkflowFulfillmentContinuation(symbolField))
      .toThrow("WORKFLOW_FULFILL_CONTINUATION_FIELD_UNSUPPORTED")
    for (const field of ["__proto__", "constructor", "prototype"] as const) {
      const special = { ...fields }
      Object.defineProperty(special, field, {
        enumerable: true,
        value: "not part of the continuation contract",
      })
      expect(() => normalizeWorkflowFulfillmentContinuation(special))
        .toThrow("WORKFLOW_FULFILL_CONTINUATION_FIELD_UNSUPPORTED")
    }

    const nullPrototype = Object.assign(Object.create(null), fields)
    expect(normalizeWorkflowFulfillmentContinuation(nullPrototype)).toEqual(fields)
    expect(normalizeWorkflowFulfillmentContinuation(JSON.parse(JSON.stringify(fields))))
      .toEqual(fields)
  })

  it("assembles an executable native-tool journey rather than a user-facing DSL lesson", () => {
    const prompt = assembleWorkflowFulfillmentPrompt({
      request: "读取访谈材料，分别提炼观点，合并为报告并执行。",
      publish: true,
      execute: true,
    })
    expect(prompt).toContain("WorkflowLoadStageContext")
    expect(prompt).toContain("sys-eidolon-anchor-devops")
    expect(prompt).not.toContain("WorkflowOpenAuthoringSession")
    expect(prompt).not.toContain("minimal-ai-data")
  })

  it("registers WorkflowFulfill as the ordinary-language native entry", () => {
    expect(WORKFLOW_NATIVE_TOOL_NAMES[0]).toBe("WorkflowFulfill")
    expect(WORKFLOW_NATIVE_TOOL_NAMES).toContain("WorkflowLoadStageContext")
    const tool = buildWorkflowNativeToolDefs().find((item) => item.schema.function.name === "WorkflowFulfill")
    expect(tool?.schema.function.parameters.required).toEqual(["request"])
    expect(tool?.schema.function.description).toContain("business goal")
    expect((tool?.schema.function.parameters.properties as any).continuation).toMatchObject({
      type: "object",
      required: ["kind"],
      additionalProperties: false,
    })
  })

  it("gives the dedicated actor a workflow-only tool surface", () => {
    const tools = BUILTIN_CODING_AGENT_CONFIGS.workflow?.tools
    expect(tools).not.toBe("*")
    expect(tools).toContain("WorkflowLoadStageContext")
    expect(tools).toContain("Skill")
    expect(tools).not.toContain("WorkflowFulfill")
    expect(tools).not.toContain("Bash")
    expect(tools).not.toContain("Write")
  })

  it("narrows the actor tool policy after an explicit stage selection", () => {
    const actor = {
      toolPolicy: {
        allowedToolsMode: "all" as "all" | "exact",
        allowedTools: ["WorkflowWorkspace", "WorkflowRun"],
      },
    }
    const coding = applyAiWorkflowStageToolPolicy(actor, "coding")
    expect(coding).toContain("WorkflowWorkspace")
    expect(coding).toContain("Skill")
    expect(coding).not.toContain("WorkflowRun")
    const monitoring = applyAiWorkflowStageToolPolicy(actor, "monitoring")
    expect(monitoring).toContain("WorkflowResult")
    expect(monitoring).toContain("Skill")
    expect(monitoring).not.toContain("WorkflowWorkspace")
    expect(actor.toolPolicy.allowedToolsMode).toBe("exact")
    expect(actor.toolPolicy.allowedTools).toEqual(monitoring)
    expect(applyAiWorkflowStageToolPolicy(actor, "improving")).toContain("Skill")
  })

  it("keeps progressive Skill loading available through the executor policy in proof and release stages", () => {
    const actor = {
      toolPolicy: { allowedTools: [] as string[] },
      modelConfig: { capabilities: { cachePolicy: { stablePrefix: true } } },
    } as any
    const providerTools = [
      "Skill",
      "WorkflowValidateAuthoringSession",
      "WorkflowPreparePublication",
      "WorkflowPublishAuthoringSession",
      "WorkflowRun",
      "WorkflowWorkspace",
    ].map((name) => ({ function: { name } }))
    const visibleAfterStage = (stage: "building" | "testing" | "releasing") => {
      applyAiWorkflowStageToolPolicy(actor, stage)
      return resolveProviderToolsetForActor(actor, providerTools).map((tool) => tool.function.name)
    }

    expect(visibleAfterStage("building")).toEqual(["Skill", "WorkflowValidateAuthoringSession"])
    expect(visibleAfterStage("testing")).toEqual([
      "Skill",
      "WorkflowPreparePublication",
      "WorkflowValidateAuthoringSession",
    ])
    expect(visibleAfterStage("releasing")).toEqual([
      "Skill",
      "WorkflowPreparePublication",
      "WorkflowPublishAuthoringSession",
      "WorkflowValidateAuthoringSession",
    ])
  })

  it("replaces the selected stage as system context instead of a user prompt", () => {
    const actor = { systemPrompts: ["root authority"] }
    applyAiWorkflowStageSystemContext(actor, "coding", "coding context")
    applyAiWorkflowStageSystemContext(actor, "testing", "testing context")
    expect(actor.systemPrompts).toEqual([
      "root authority",
      "<!-- eidolon:sys-eidolon-anchor-devops-stage=testing -->\ntesting context",
    ])
  })
})
