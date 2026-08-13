import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createWorkflowComponent } from "../../src/workflow"

const MANIFEST = `<AIDataWorkflow #demo.workflow.Proofs apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #demo.workflow.Proofs { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <ReturnNode #return { inputs = { result = "flow-port://#entry/input" } }>
]>
`

describe("workflow publication proof pipeline", () => {
  it("rejects a flow-code effect invocation that omits the exact run capability", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-proof-effect-contract-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const manifest = `<AIDataWorkflow #demo.workflow.InvalidEffect apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #demo.workflow.InvalidEffect { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <TransformNode #effect {
    inputs = { input = "flow-port://#entry/input" }
    outputs = ["result"]
    src = "vfs://./flow-code/index.ts#invalidEffect"
  }>
  <ReturnNode #return { inputs = { result = "flow-port://#effect/result" } }>
]>
`
    const session = await component.sessions.open({
      sessionId: "invalid-effect-contract",
      form: "AIDataWorkflow",
      source: [
        { path: "manifest.xnl", content: manifest },
        {
          path: "flow-code/index.ts",
          content: `export async function invalidEffect(runtime: any, input: any, config: any) {
  const effects = runtime.ai.effects
  const result = await effects.invoke({ effectId: "invalid", operation: "identity", input, config })
  return { result }
}\n`,
        },
      ],
      target: { path: "invalid-effect-contract" },
    })

    await expect(component.sessions.preparePublication({ sessionId: session.sessionId }))
      .rejects.toThrow("data-code-effect-contract")
  })

  it("rejects a flow-code effect invocation with a forged run capability", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-proof-forged-run-contract-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const manifest = `<AIDataWorkflow #demo.workflow.ForgedRun apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #demo.workflow.ForgedRun { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <TransformNode #effect {
    inputs = { input = "flow-port://#entry/input" }
    outputs = ["result"]
    src = "vfs://./flow-code/index.ts#forgedRun"
  }>
  <ReturnNode #return { inputs = { result = "flow-port://#effect/result" } }>
]>
`
    const session = await component.sessions.open({
      sessionId: "forged-run-contract",
      form: "AIDataWorkflow",
      source: [
        { path: "manifest.xnl", content: manifest },
        {
          path: "flow-code/index.ts",
          content: `export async function forgedRun(runtime: any, input: any, config: any) {
  const result = await runtime.ai.effects.invoke({
    run: { runId: "forged", generation: 0, workflow: { ref: "resource://forged", scheme: "resource" } },
    effectId: "invalid",
    operation: "identity",
    input,
    config,
  })
  return { result }
}\n`,
        },
      ],
      target: { path: "forged-run-contract" },
    })

    await expect(component.sessions.preparePublication({ sessionId: session.sessionId }))
      .rejects.toThrow("data-code-effect-contract")
  })

  it("rejects a run alias obtained from a lookalike object instead of the handler runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-proof-lookalike-run-contract-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const manifest = `<AIDataWorkflow #demo.workflow.LookalikeRun apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #demo.workflow.LookalikeRun { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <TransformNode #effect {
    inputs = { input = "flow-port://#entry/input" }
    outputs = ["result"]
    src = "vfs://./flow-code/index.ts#lookalikeRun"
  }>
  <ReturnNode #return { inputs = { result = "flow-port://#effect/result" } }>
]>
`
    const session = await component.sessions.open({
      sessionId: "lookalike-run-contract",
      form: "AIDataWorkflow",
      source: [
        { path: "manifest.xnl", content: manifest },
        {
          path: "flow-code/index.ts",
          content: `export async function lookalikeRun(runtime: any, input: any, config: any) {
  const fake = { ai: { metadata: { run: runtime.ai.metadata.run } } }
  const run = fake.ai.metadata.run
  const result = await runtime.ai.effects.invoke({ run, effectId: "invalid", operation: "identity", input, config })
  return { result }
}\n`,
        },
      ],
      target: { path: "lookalike-run-contract" },
    })

    await expect(component.sessions.preparePublication({ sessionId: session.sessionId }))
      .rejects.toThrow("data-code-effect-contract")
  })

  it("fails closed for misplaced runtime parameters and computed effect capability access", async () => {
    const cases = [
      {
        suffix: "misplaced-runtime",
        exportName: "misplacedRuntime",
        source: `export async function misplacedRuntime(input: any, runtime: any, config: any) {
  const result = await runtime.ai.effects.invoke({ run: runtime.ai.metadata.run, effectId: "invalid", operation: "identity", input, config })
  return { result }
}\n`,
      },
      {
        suffix: "computed-capability",
        exportName: "computedCapability",
        source: `export async function computedCapability(runtime: any, input: any, config: any) {
  const fake = { ai: { metadata: { run: runtime.ai.metadata.run } } }
  const result = await runtime["ai"]["effects"].invoke({ run: fake["ai"]["metadata"]["run"], effectId: "invalid", operation: "identity", input, config })
  return { result }
}\n`,
      },
      {
        suffix: "computed-invoke",
        exportName: "computedInvoke",
        source: `export async function computedInvoke(runtime: any, input: any, config: any) {
  const result = await runtime.ai.effects["invoke"]({ run: runtime.ai.metadata.run, effectId: "invalid", operation: "identity", input, config })
  return { result }
}\n`,
      },
    ]

    for (const item of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), `eidolon-workflow-proof-${item.suffix}-`))
      const component = createWorkflowComponent({ workspaceRoot: root })
      const fqn = `demo.workflow.${item.exportName}`
      const manifest = `<AIDataWorkflow #${fqn} apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #${fqn} { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <TransformNode #effect {
    inputs = { input = "flow-port://#entry/input" }
    outputs = ["result"]
    src = "vfs://./flow-code/index.ts#${item.exportName}"
  }>
  <ReturnNode #return { inputs = { result = "flow-port://#effect/result" } }>
]>
`
      const session = await component.sessions.open({
        sessionId: item.suffix,
        form: "AIDataWorkflow",
        source: [
          { path: "manifest.xnl", content: manifest },
          { path: "flow-code/index.ts", content: item.source },
        ],
        target: { path: item.suffix },
      })

      await expect(component.sessions.preparePublication({ sessionId: session.sessionId }))
        .rejects.toThrow("data-code-effect-contract")
    }
  })

  it("rejects local-helper flow-code return maps that disagree with declared node outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-proof-output-contract-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const manifest = `<AIDataWorkflow #demo.workflow.InvalidOutput apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #demo.workflow.InvalidOutput { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <TransformNode #fetch {
    inputs = { input = "flow-port://#entry/input" }
    outputs = ["result"]
    src = "vfs://./flow-code/index.ts#fetch"
  }>
  <ReturnNode #return { inputs = { result = "flow-port://#fetch/result" } }>
]>
`
    const session = await component.sessions.open({
      sessionId: "invalid-output-contract",
      form: "AIDataWorkflow",
      source: [
        { path: "manifest.xnl", content: manifest },
        {
          path: "flow-code/index.ts",
          content: `async function fetchSource(_runtime: any, source: string) {
  return { status: "ok", source, items: [] }
}
export async function fetch(runtime: any, _input: any, _config: any) {
  return fetchSource(runtime, "example")
}\n`,
        },
      ],
      target: { path: "invalid-output-contract" },
    })

    await expect(component.sessions.preparePublication({ sessionId: session.sessionId }))
      .rejects.toThrow("data-code-output-contract")
  })

  it("prepares one digest-bound complete receipt set and publishes those identities", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-proof-pipeline-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const session = await component.sessions.open({
      sessionId: "proofs",
      form: "AIDataWorkflow",
      source: [{ path: "manifest.xnl", content: MANIFEST }],
      target: { path: "proofs" },
    })

    const prepared = await component.sessions.preparePublication({ sessionId: session.sessionId })
    const proofSet = prepared.proofSet
    expect(proofSet.revision).toBe(prepared.revision)
    expect(proofSet.bundleDigest).toBe(prepared.revision)
    expect(proofSet.diffReceipt.kind).toBe("workflow.diffReceipt")
    expect(proofSet.validationReceipt.kind).toBe("workflow.validationReceipt")
    expect(proofSet.staticProjectionReceipt).toMatchObject({
      kind: "workflow.staticProjectionReceipt",
      effectDispatched: false,
      acceptanceClaimed: false,
    })
    expect(proofSet.buildReceipt).toMatchObject({
      kind: "workflow.buildReceipt",
      definitionFqn: "demo.workflow.Proofs",
      bundleDigest: prepared.revision,
    })
    expect(proofSet.acceptanceDispositionReceipt).toMatchObject({
      kind: "workflow.acceptanceDispositionReceipt",
      disposition: "not_required",
      policySource: "canonical-profile:effect-free-default",
    })

    const published = await component.sessions.publish({ sessionId: session.sessionId, confirmed: true }) as any
    expect(published.receipt.workflowRef).toBe("resource://demo.workflow.Proofs")
    expect(published.receipt.contract).toEqual({ inputPorts: ["input"], outputPorts: ["result"] })
    expect(published.receipt.proofReceiptIds).toEqual([
      proofSet.diffReceipt.receiptId,
      proofSet.validationReceipt.receiptId,
      proofSet.staticProjectionReceipt.receiptId,
      proofSet.buildReceipt.receiptId,
      proofSet.acceptanceDispositionReceipt.receiptId,
    ])
  })

  it("invalidates the complete proof set on mutation and rejects stale publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-proof-stale-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const session = await component.sessions.open({
      sessionId: "stale",
      form: "AIDataWorkflow",
      source: [{ path: "manifest.xnl", content: MANIFEST }],
      target: { path: "stale" },
    })
    await component.sessions.preparePublication({ sessionId: session.sessionId })
    await component.sessions.write(session.sessionId, "/work/notes.md", "changed\n")
    expect((await component.sessions.describe(session.sessionId)).proofSet).toBeUndefined()
    await expect(component.sessions.publish({ sessionId: session.sessionId, confirmed: true }))
      .rejects.toThrow("requires current diff, validation and dry-run revisions")
  })

  it("accepts required candidate evidence only through an installed isolated fixture harness", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-proof-candidate-"))
    const calls: string[] = []
    const component = createWorkflowComponent({
      workspaceRoot: root,
      candidateHarness: {
        run: async ({ fixtureId }) => {
          calls.push(fixtureId)
          return {
            outcome: "passed" as const,
            evidence: { fixtureId, terminal: true },
            isolated: true as const,
            realEffectDispatched: false as const,
            runtime: "canonical-depa-flows" as const,
            effectProvider: "isolated-fixture" as const,
          }
        },
      },
    })
    const session = await component.sessions.open({
      sessionId: "candidate",
      form: "AIDataWorkflow",
      source: [{ path: "manifest.xnl", content: MANIFEST }],
      target: { path: "candidate" },
    })
    const prepared = await component.sessions.preparePublication({
      sessionId: session.sessionId,
      acceptancePolicy: {
        requirement: "required",
        source: "definition-policy:demo.workflow.Proofs/acceptance",
        fixtureId: "fixture://proofs/success",
      },
    })
    expect(calls).toEqual(["fixture://proofs/success"])
    expect(prepared.proofSet.candidateAcceptanceReceipt).toMatchObject({
      outcome: "passed",
      isolated: true,
      realEffectDispatched: false,
      runtime: "canonical-depa-flows",
      effectProvider: "isolated-fixture",
    })
  })

  it("generates typed terminal receipts from persisted authority and rejects stale model claims", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-authoring-receipt-"))
    const component = createWorkflowComponent({ workspaceRoot: root })
    const session = await component.sessions.open({
      sessionId: "terminal-receipt",
      form: "AIDataWorkflow",
      source: [{ path: "manifest.xnl", content: MANIFEST }],
      target: { path: "terminal-receipt" },
    })
    const prepared = await component.sessions.preparePublication({ sessionId: session.sessionId })
    await expect(component.sessions.createAuthoringReceipt({
      sessionId: session.sessionId,
      expectedWorkingRevision: "sha256:forged",
      stage: "testing",
      outcome: "ready",
    })).rejects.toThrow("revision conflict")

    const ready = await component.sessions.createAuthoringReceipt({
      sessionId: session.sessionId,
      expectedWorkingRevision: prepared.revision,
      stage: "testing",
      outcome: "ready",
    })
    expect(ready).toMatchObject({
      kind: "workflow.authoringReceipt",
      authoringSessionId: session.sessionId,
      outcome: "ready",
      dirty: true,
      nextAction: "request_publication_authorization_or_finish",
    })
    expect(ready.proofReceiptIds).toEqual([
      prepared.proofSet.diffReceipt.receiptId,
      prepared.proofSet.validationReceipt.receiptId,
      prepared.proofSet.staticProjectionReceipt.receiptId,
      prepared.proofSet.buildReceipt.receiptId,
      prepared.proofSet.acceptanceDispositionReceipt.receiptId,
    ])

    await component.sessions.publish({ sessionId: session.sessionId, confirmed: true })
    const published = await component.sessions.createAuthoringReceipt({
      sessionId: session.sessionId,
      expectedWorkingRevision: prepared.revision,
      stage: "releasing",
      outcome: "published",
    })
    expect(published.dirty).toBe(false)
    expect(published.publicationReceiptId).toBe((await component.sessions.describe(session.sessionId)).latestPublicationReceiptId)
  })

  it("records isolated partial-source degradation and rejects an all-required-sources failure", async () => {
    const createCandidate = async (outcome: "passed" | "failed", suffix: string) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `eidolon-workflow-source-fixture-${suffix}-`))
      const component = createWorkflowComponent({
        workspaceRoot: root,
        candidateHarness: {
          run: async () => ({
            outcome,
            evidence: outcome === "passed"
              ? { sources: { hackerNews: "failed", github: "succeeded", dev: "succeeded" }, degraded: true }
              : { sources: { hackerNews: "failed", github: "failed", dev: "failed" }, terminal: "Failed" },
            isolated: true,
            realEffectDispatched: false,
            runtime: "canonical-depa-flows",
            effectProvider: "isolated-fixture",
          }),
        },
      })
      const session = await component.sessions.open({
        sessionId: `source-fixture-${suffix}`,
        form: "AIDataWorkflow",
        source: [{ path: "manifest.xnl", content: MANIFEST }],
        target: { path: `source-fixture-${suffix}` },
      })
      return { component, session }
    }

    const degraded = await createCandidate("passed", "degraded")
    const prepared = await degraded.component.sessions.preparePublication({
      sessionId: degraded.session.sessionId,
      acceptancePolicy: {
        requirement: "required",
        source: "definition-policy:demo.workflow.Proofs/multi-source",
        fixtureId: "fixture://sources/one-failed",
      },
    })
    expect(prepared.proofSet.candidateAcceptanceReceipt?.outcome).toBe("passed")

    const failed = await createCandidate("failed", "failed")
    await expect(failed.component.sessions.preparePublication({
      sessionId: failed.session.sessionId,
      acceptancePolicy: {
        requirement: "required",
        source: "definition-policy:demo.workflow.Proofs/multi-source",
        fixtureId: "fixture://sources/all-required-failed",
      },
    })).rejects.toThrow("isolated candidate acceptance did not pass: failed")
  })
})
