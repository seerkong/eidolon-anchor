import { describe, expect, it } from "bun:test"

import { WorkflowResourceLoader } from "../../src/workflow/resources"
import { WorkflowCommandService } from "../../src/workflow/component/WorkflowCommandService"

const ctrlSource = `<AICtrlWorkflow #local.workflow.Ctrl apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #local.workflow.Ctrl>
) [
  <Return #done>
]>
`

const dataSource = `<AIDataWorkflow #local.workflow.Data apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #local.workflow.Data { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <ReturnNode #return { inputs = { result = "flow-port://#entry/input" } }>
]>
`

describe("WorkflowResourceLoader", () => {
  it("loads both canonical AI workflow forms through depa-flows bindings", () => {
    const loader = new WorkflowResourceLoader()
    const ctrl = loader.load({ form: "AICtrlWorkflow", sources: { "manifest.xnl": ctrlSource } })
    const data = loader.load({ form: "AIDataWorkflow", sources: { "manifest.xnl": dataSource } })

    expect(ctrl.diagnostics).toEqual([])
    expect(ctrl.binding).toMatchObject({
      kind: "AICtrlWorkflow",
      substrate: "WorkCtrlFlow",
      definition: { fqn: "local.workflow.Ctrl" },
    })
    expect(data.diagnostics).toEqual([])
    expect(data.binding).toMatchObject({
      kind: "AIDataWorkflow",
      substrate: "EagerDataFlow",
      definition: { fqn: "local.workflow.Data" },
    })
  })

  it("auto-detects a valid canonical form without parsing XNL locally", () => {
    const result = new WorkflowResourceLoader().load({
      sources: { "manifest.xnl": dataSource },
    })

    expect(result.form).toBe("AIDataWorkflow")
    expect(result.binding?.kind).toBe("AIDataWorkflow")
    expect(result.diagnostics).toEqual([])
  })

  it("normalizes canonical diagnostics and never returns a binding for invalid sources", () => {
    const invalid = ctrlSource.replace("<Return #done>", "<TaskStep #done>")
    const result = new WorkflowResourceLoader().load({
      form: "AICtrlWorkflow",
      sources: { "manifest.xnl": invalid },
    })

    expect(result.binding).toBeUndefined()
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: "AICtrlWorkflow",
          code: "statement-not-allowed",
        }),
      ]),
    )
  })

  it("proves deterministic ctrl and data drafts through the canonical loaders", () => {
    const commands = new WorkflowCommandService()
    const ctrl = commands.createBundleDraft({
      form: "ai-ctrl",
      name: "Review Control",
      fqn: "local.workflow.ReviewControl",
    })
    const data = commands.createBundleDraft({
      form: "ai-data",
      name: "Evidence Data",
      fqn: "local.workflow.EvidenceData",
    })

    expect(ctrl.files.find((file) => file.ref === "vfs://./manifest.xnl")?.content)
      .toContain("<AICtrlWorkflow #local.workflow.ReviewControl")
    expect(ctrl.canonicalProof).toEqual({
      valid: true,
      form: "AICtrlWorkflow",
      substrate: "WorkCtrlFlow",
      definitionFqn: "local.workflow.ReviewControl",
      diagnostics: [],
    })
    expect(data.files.find((file) => file.ref === "vfs://./manifest.xnl")?.content)
      .toContain("<AIDataWorkflow #local.workflow.EvidenceData")
    expect(data.canonicalProof).toEqual({
      valid: true,
      form: "AIDataWorkflow",
      substrate: "EagerDataFlow",
      definitionFqn: "local.workflow.EvidenceData",
      diagnostics: [],
    })
  })

  it("accepts a complete actor-authored canonical manifest and rejects identity drift", () => {
    const commands = new WorkflowCommandService()
    const flowCode = "export function customNode(_runtime: unknown, input: unknown) { return { result: input } }"
    const authored = commands.createBundleDraft({
      form: "ai-data",
      name: "Authored Data",
      fqn: "local.workflow.AuthoredData",
      manifest_content: dataSource.replaceAll("local.workflow.Data", "local.workflow.AuthoredData"),
      flow_code_content: flowCode,
    })
    expect(authored.canonicalProof.definitionFqn).toBe("local.workflow.AuthoredData")
    expect(authored.files.find((file) => file.ref === "vfs://./flow-code/index.ts")?.content).toBe(flowCode)
    expect(() => commands.createBundleDraft({
      form: "ai-data",
      name: "Wrong Identity",
      fqn: "local.workflow.Expected",
      manifest_content: dataSource,
    })).toThrow("FQN mismatch")
  })
})
