import { describe, expect, test } from "bun:test"

import {
  PROVIDER_CACHE_PRODUCT_PRODUCTION_SCENARIOS,
  openVerifiedProductChild,
  runClosedProviderCacheProductScenario,
  type OpenedVerifiedProductChild,
} from "../../src/llm/internal/ProviderCacheProductRuntime"
import {
  WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES,
  WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES,
} from "../../src/workflow/tools/WorkflowToolCatalog"

type ScenarioId = typeof PROVIDER_CACHE_PRODUCT_PRODUCTION_SCENARIOS[number]

async function openScenario(scenarioId: ScenarioId): Promise<readonly OpenedVerifiedProductChild[]> {
  const handles = await runClosedProviderCacheProductScenario({ scenarioId })
  return Object.freeze(handles.map((handle) => openVerifiedProductChild(handle)))
}

function rows(child: OpenedVerifiedProductChild, kind: string) {
  return child.sourceRecords.filter((record) => record.kind === kind)
}

function finalWireFacts(child: OpenedVerifiedProductChild) {
  return rows(child, "final_wire")
    .sort((left, right) => left.identity.callOrdinal! - right.identity.callOrdinal!)
    .map((record) => record.facts as Readonly<{
      toolNames: readonly string[]
      body: string
      captureLayer: string
      cacheUnits: readonly unknown[]
    }>)
}

describe("provider cache deterministic product E2E", () => {
  test("runs ordinary no-tool and Code all-tools through the closed addressed product gateway", async () => {
    const [noTool] = await openScenario("ordinary.no-tool.forward/v1")
    const [allTools] = await openScenario("ordinary.code.all-tools/v1")
    expect(noTool!.callCount).toBe(2)
    expect(allTools!.callCount).toBe(1)
    for (const child of [noTool!, allTools!]) {
      expect(rows(child, "request_admission")).toHaveLength(child.callCount)
      expect(rows(child, "final_success_usage")).toHaveLength(child.callCount)
      expect(finalWireFacts(child).every((facts) => facts.captureLayer === "provider_transport_before_send")).toBe(true)
    }
    const noToolNames = finalWireFacts(noTool!)[0]!.toolNames
    const allToolNames = finalWireFacts(allTools!)[0]!.toolNames
    expect(allToolNames.length).toBeGreaterThan(noToolNames.length)
    expect(WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES.every((name) => allToolNames.includes(name))).toBe(true)
    expect(allToolNames.filter((name) => WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES.includes(name as any))).toEqual([])
  }, 60_000)

  test("closes reasoning parallel tools and exact retry attempts without duplicate usages", async () => {
    const [tools] = await openScenario("tool.reasoning-parallel-pending/v1")
    const [retry] = await openScenario("transport.retry-503/v1")
    expect(rows(tools!, "tool_effect")).toHaveLength(2)
    expect(rows(tools!, "final_success_usage")).toHaveLength(2)
    expect(rows(retry!, "final_success_usage")).toHaveLength(1)
    const retryAttempts = rows(retry!, "transport_attempt")
    expect(retryAttempts).toHaveLength(2)
    expect(new Set(retryAttempts.map((record) => (record.facts as any).bodyDigest)).size).toBe(1)
    expect((retryAttempts.at(-1)!.facts as any).status).toBe("final_success")
  }, 60_000)

  test("fresh recovery continues through two owner-verified opaque children", async () => {
    const children = await openScenario("recovery.fresh-runtime/v1")
    expect(children.map((child) => child.childId)).toEqual([
      "recovery.fresh-runtime/v1#initial-runtime",
      "recovery.fresh-runtime/v1#recovered-runtime",
    ])
    expect(children.map((child) => child.callCount)).toEqual([1, 1])
    expect(children.map((child) => child.recoveryBoundary)).toEqual([false, true])
    expect(new Set(children.map((child) => child.actorId)).size).toBe(1)
    expect(new Set(children.map((child) => child.sessionId)).size).toBe(1)
    expect(children.every((child) => rows(child, "request_admission").length === 1
      && rows(child, "final_wire").length === 1
      && rows(child, "final_success_usage").length === 1)).toBe(true)
  }, 60_000)

  test("keeps real AI Ctrl/Data node final wires stage-free", async () => {
    const [ctrl] = await openScenario("workflow.ctrl-node.stage-free/v1")
    const [data] = await openScenario("workflow.data-node.stage-free/v1")
    expect([ctrl!.actorClass, data!.actorClass]).toEqual(["workflow_ctrl_node", "workflow_data_node"])
    for (const child of [ctrl!, data!]) {
      expect(child.callCount).toBe(1)
      expect(rows(child, "provider_epoch").map((record) => (record.facts as any).reason)).toEqual(["initial_projection"])
      expect(finalWireFacts(child)[0]!.toolNames
        .filter((name) => WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES.includes(name as any))).toEqual([])
    }
    expect(ctrl!.actorId).not.toBe(data!.actorId)
  }, 60_000)

  test("retains exactly 128 final-wire messages plus one addressed append", async () => {
    const [long] = await openScenario("context.long-128/v1")
    expect(finalWireFacts(long!).map((facts) => {
      const body = JSON.parse(facts.body) as { messages?: unknown }
      return Array.isArray(body.messages) ? body.messages.length : null
    })).toEqual([128, 129])
    expect(rows(long!, "request_admission")).toHaveLength(2)
    expect(rows(long!, "provider_epoch")).toHaveLength(2)
  }, 60_000)

  test("observes the real four-actor/two-session transport interleave", async () => {
    const children = await openScenario("isolation.four-actors-two-sessions/v1")
    expect(children.map((child) => child.actorClass)).toEqual([
      "ordinary", "workflow_lifecycle", "workflow_ctrl_node", "workflow_data_node",
    ])
    expect(new Set(children.map((child) => child.actorId)).size).toBe(4)
    expect(new Set(children.map((child) => child.sessionId)).size).toBe(2)
    const sequence = children.flatMap((child) => rows(child, "transport_attempt")
      .filter((record) => record.identity.attemptOrdinal === 1)
      .map((record) => ({
        actorClass: child.actorClass,
        globalOrdinal: (record.facts as any).globalOrdinal,
        sessionId: child.sessionId,
      })))
      .sort((left, right) => left.globalOrdinal - right.globalOrdinal)
    expect(sequence.map(({ globalOrdinal, actorClass }) => [globalOrdinal, actorClass])).toEqual([
      [1, "ordinary"],
      [2, "workflow_lifecycle"],
      [3, "workflow_ctrl_node"],
      [4, "workflow_data_node"],
      [5, "ordinary"],
    ])
  }, 60_000)
})
