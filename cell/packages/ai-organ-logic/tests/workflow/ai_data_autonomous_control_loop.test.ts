import { describe, expect, it } from "bun:test"

import type {
  AIDataControlAdmission,
  AIDataControlBudget,
  AIDataControlCapabilityCatalog,
  AIDataControlDecision,
  AIDataControlGoal,
  AIDataControlObservation,
  AIDataControlVerifierFact,
  AIDataWorkflowRunGraph,
} from "ai-data-workflow-contract"
import {
  admitAIDataControlDecision,
  createAIDataControlRuntime,
  freezeAIDataControlCapabilityCatalog,
  projectAIDataControlObservation,
} from "ai-data-workflow-logic"
import type { AIWorkflowFlowRunCheckpoint, AIWorkflowProfileDurableState } from "ai-workflow-contract"

import {
  AIDataAutonomousControlInvariantError,
  createAIDataAutonomousControlState,
  readAIDataAutonomousControlState,
  selectAIDataAgentDispatch,
  transitionAIDataAutonomousControlCheckpoint,
  writeAIDataAutonomousControlExtension,
} from "../../src/workflow/runtime/AIDataAutonomousControlLoop"
import { runAIDataAutonomousControlLoop } from "../../src/workflow/runtime/AIDataAutonomousControlRunner"

const controlRuntime = createAIDataControlRuntime()

const goal: AIDataControlGoal = Object.freeze({
  schemaVersion: "depa.ai-data-control/v1",
  goalId: "goal-1",
  objective: "Produce a verified value",
  verifierRef: "resource://fixture.verifier",
  requiredOutputSchemaRef: "schema://fixture/value",
})

const budget: AIDataControlBudget = Object.freeze({
  schemaVersion: "depa.ai-data-control/v1",
  limits: {
    maxIterations: 4,
    maxOperationsPerDecision: 2,
    maxNoProgressIterations: 2,
  },
  usage: { iteration: 0, noProgressIterations: 0 },
})

const catalog: AIDataControlCapabilityCatalog = freezeAIDataControlCapabilityCatalog(controlRuntime, {
  schemaVersion: "depa.ai-data-control/v1",
  catalogId: "fixture-catalog",
  foundationNodes: {
    entry: { protected: true, inputSchemaRefs: {}, outputSchemaRefs: { value: "schema://fixture/value" } },
    worker: { protected: false, inputSchemaRefs: { value: "schema://fixture/value" }, outputSchemaRefs: { value: "schema://fixture/value" } },
    return: { protected: true, inputSchemaRefs: { value: "schema://fixture/value" }, outputSchemaRefs: {} },
    control: { protected: true, inputSchemaRefs: {}, outputSchemaRefs: {} },
  },
  capabilities: {},
}, {})

function runGraph(): AIDataWorkflowRunGraph {
  const reusable = (nodeType: string) => ({ policy: nodeType === "manual" ? "never" : "semantic-hash", source: "node-type-default", nodeType }) as any
  const graph = {
    runId: "run-1",
    binding: {
      kind: "AIDataWorkflow",
      substrate: "EagerDataFlow",
      definition: {
        form: "EagerDataFlow",
        fqn: "fixture.AutonomousData",
        apiVersion: "depa.flows/v1",
        version: "1",
        sourceNames: ["fixture"],
        contract: { inputPorts: ["value"], outputPorts: ["value"] },
        nodes: [],
        nodeById: {},
        declarationOrder: ["entry", "worker", "return", "control"],
        dataEdges: [],
        waitForEdges: [],
        subflowEdges: [],
        diagnostics: [],
      },
    },
    currentGeneration: 0,
    declarationOrder: ["entry", "worker", "return", "control"],
    patchHistory: [],
    invalidations: [],
    nodes: {
      entry: {
        id: "entry", tag: "EntryNode", nodeType: "data", generation: 0, status: "Succeeded", declarationIndex: 0,
        inputs: {}, outputs: ["value"], config: {}, dependsOn: [], dependents: ["worker"], reusePolicy: reusable("data"),
        result: { nodeId: "entry", generation: 0, status: "Succeeded", output: { value: "draft" } },
      },
      worker: {
        id: "worker", tag: "TransformNode", nodeType: "agent", generation: 0, status: "Succeeded", declarationIndex: 1,
        inputs: { value: { ref: "flow-port://#entry/value", nodeId: "entry", port: "value" } }, outputs: ["value"], config: {},
        dependsOn: ["entry"], dependents: ["return"], reusePolicy: reusable("agent"),
        result: { nodeId: "worker", generation: 0, status: "Succeeded", output: { value: "accepted" } },
      },
      return: {
        id: "return", tag: "ReturnNode", nodeType: "data", generation: 0, status: "Succeeded", declarationIndex: 2,
        inputs: { value: { ref: "flow-port://#worker/value", nodeId: "worker", port: "value" } }, outputs: [], config: {},
        dependsOn: ["worker"], dependents: [], reusePolicy: reusable("data"),
        result: { nodeId: "return", generation: 0, status: "Succeeded", output: { value: "accepted" } },
      },
      control: {
        id: "control", tag: "TransformNode", nodeType: "manual", generation: 0, status: "Running", declarationIndex: 3,
        inputs: {}, outputs: [], config: { node_type: "manual" }, dependsOn: [], dependents: [], reusePolicy: reusable("manual"),
        result: { nodeId: "control", generation: 0, status: "Waiting" },
      },
    },
  }
  return graph as AIDataWorkflowRunGraph
}

function verifier(status: "passed" | "failed"): AIDataControlVerifierFact {
  return Object.freeze({
    schemaVersion: "depa.ai-data-control/v1",
    factId: `verifier-0-${status}`,
    goalId: goal.goalId,
    graphGeneration: 0,
    status,
    verifierRef: goal.verifierRef,
    requiredOutputSchemaRef: goal.requiredOutputSchemaRef,
    diagnostics: status === "passed" ? [] : [{ code: "VALUE_REJECTED", message: "value is not accepted" }],
  })
}

function observation(graph: AIDataWorkflowRunGraph, fact: AIDataControlVerifierFact): AIDataControlObservation {
  return projectAIDataControlObservation(controlRuntime, {
    goal,
    budget,
    catalog,
    graph,
    verifier: fact,
    feedback: [],
  }, { maxObservedNodes: 16 })
}

function completionDecision(observed: AIDataControlObservation, fact: AIDataControlVerifierFact): AIDataControlDecision {
  return Object.freeze({
    schemaVersion: "depa.ai-data-control/v1",
    kind: "complete",
    decisionId: "decision-complete",
    goalId: goal.goalId,
    observationId: observed.observationId,
    observationDigest: observed.observationDigest,
    catalogDigest: catalog.digest,
    reason: "the immutable verifier passed",
    verifierFactId: fact.factId,
    outputNodeId: "worker",
    outputPort: "value",
    outputSchemaRef: goal.requiredOutputSchemaRef,
  })
}

function checkpoint(graph: AIDataWorkflowRunGraph): AIWorkflowFlowRunCheckpoint {
  const autonomousControl = createAIDataAutonomousControlState({
    controlNodeId: "control",
    goal,
    catalog,
    budget,
    controller: {
      taskProofRef: "resource://fixture.ControllerBinding",
      agentDefinitionRef: "resource://fixture.ControllerAgent",
      instanceName: "control-agent",
    },
    maxObservedNodes: 16,
  })
  return {
    schemaVersion: "depa.flow-run-checkpoint/v1",
    runId: graph.runId,
    instanceId: "instance-1",
    definition: { revision: "revision-1", digest: "sha256:fixture", provenance: { authority: "test", artifactRef: "fixture" } },
    version: 7,
    input: { value: "draft" },
    config: {},
    state: { status: "Running", generation: graph.currentGeneration },
    output: null,
    controllerSidecars: { status: "Running" },
    nodeSidecars: {},
    stepExtensions: writeAIDataAutonomousControlExtension(undefined, autonomousControl),
    profile: {
      kind: "AIDataWorkflow",
      runGraph: graph,
      ai: { schemaVersion: "depa.ai-agent-state/v1", instancesById: {}, instanceIdByName: {}, invocationsByKey: {} },
    },
  }
}

describe("AI Data autonomous control checkpoint authority", () => {
  it("releases the explicit protected barrier only with the current host-owned passing verifier and records the receipt atomically", () => {
    const graph = runGraph()
    const passed = verifier("passed")
    const observed = observation(graph, passed)
    const decision = completionDecision(observed, passed)
    const admission = admitAIDataControlDecision(controlRuntime, {
      goal, budget, catalog, graph, verifier: passed, observation: observed, decision,
    }, {})
    expect(admission.kind).toBe("complete")

    const next = transitionAIDataAutonomousControlCheckpoint(checkpoint(graph), {
      observation: observed,
      decision,
      admission,
      verifier: passed,
    })

    expect(next.version).toBe(8)
    expect((next.profile as any).runGraph.nodes.control).toMatchObject({
      status: "Succeeded",
      result: { status: "Succeeded", generation: 0 },
    })
    expect(next.controllerSidecars).toEqual({ status: "Succeeded" })
    expect((next.stepExtensions as any).byStepId.control["eidolon.ai-data-autonomous-control"].value).toMatchObject({
        phase: "completed",
        iteration: 1,
        receipts: [{ admissionKind: "complete", generationBefore: 0, generationAfter: 0 }],
    })

    const failed = verifier("failed")
    expect(() => transitionAIDataAutonomousControlCheckpoint(checkpoint(graph), {
      observation: observed,
      decision,
      admission,
      verifier: failed,
    })).toThrow(AIDataAutonomousControlInvariantError)
  })

  it("records rejected feedback without mutating graph generation or digest", () => {
    const graph = runGraph()
    const failed = verifier("failed")
    const observed = observation(graph, failed)
    const decision = completionDecision(observed, failed)
    const admission = admitAIDataControlDecision(controlRuntime, {
      goal, budget, catalog, graph, verifier: failed, observation: observed, decision,
    }, {})
    expect(admission).toMatchObject({ kind: "rejected", feedback: [{ code: "VERIFIER_REQUIRED" }] })
    const before = controlRuntime.stableDigest(graph)

    const next = transitionAIDataAutonomousControlCheckpoint(checkpoint(graph), {
      observation: observed,
      decision,
      admission,
      verifier: failed,
    })

    expect((next.profile as any).runGraph.currentGeneration).toBe(0)
    expect(controlRuntime.stableDigest((next.profile as any).runGraph)).toBe(before)
    expect((next.stepExtensions as any).byStepId.control["eidolon.ai-data-autonomous-control"].value).toMatchObject({
      phase: "planning",
      iteration: 1,
      noProgressCount: 1,
      feedback: [{ code: "VERIFIER_REQUIRED" }],
      receipts: [{ admissionKind: "rejected", generationBefore: 0, generationAfter: 0 }],
    })
  })
})

describe("AI Data exact Agent instance selection", () => {
  const input = {
    instanceName: "control-agent",
    agentDefinitionRef: "resource://fixture.ControllerAgent" as const,
    payload: { observationId: "observation-1" },
  }

  it("selects new once, then exact byId targeted dispatch", () => {
    const empty: AIWorkflowProfileDurableState = {
      schemaVersion: "depa.ai-agent-state/v1",
      instancesById: {},
      instanceIdByName: {},
      invocationsByKey: {},
    }
    expect(selectAIDataAgentDispatch(empty, input)).toEqual({
      mode: "new",
      input: input.payload,
      config: { agentDefinitionRef: input.agentDefinitionRef, instanceName: input.instanceName },
    })

    const reused: AIWorkflowProfileDurableState = {
      ...empty,
      instancesById: {
        "agent-1": {
          authority: "eidolon.session",
          instanceId: "agent-1",
          instanceName: input.instanceName,
          sessionId: "session-1",
          agentDefinitionRef: input.agentDefinitionRef,
        },
      },
      instanceIdByName: { [input.instanceName]: "agent-1" },
    }
    expect(selectAIDataAgentDispatch(reused, input)).toEqual({
      mode: "targeted",
      selector: { byId: "agent-1" },
      invocation: { kind: "ai.agent", payload: input.payload },
      config: { agentDefinitionRef: input.agentDefinitionRef },
    })
  })

  it("fails closed for missing reciprocal or mismatched AgentDefinition instead of falling back to new", () => {
    const base: AIWorkflowProfileDurableState = {
      schemaVersion: "depa.ai-agent-state/v1",
      instancesById: {
        "agent-1": {
          authority: "eidolon.session",
          instanceId: "agent-1",
          instanceName: input.instanceName,
          agentDefinitionRef: input.agentDefinitionRef,
        },
      },
      instanceIdByName: {},
      invocationsByKey: {},
    }
    expect(() => selectAIDataAgentDispatch(base, input)).toThrow(AIDataAutonomousControlInvariantError)
    expect(() => selectAIDataAgentDispatch({
      ...base,
      instanceIdByName: { [input.instanceName]: "agent-1" },
      instancesById: {
        "agent-1": { ...base.instancesById["agent-1"]!, agentDefinitionRef: "resource://fixture.OtherAgent" },
      },
    }, input)).toThrow(AIDataAutonomousControlInvariantError)
  })
})

describe("AI Data bounded autonomous control runner", () => {
  it("turns malformed controller output into bounded feedback, then replans from the next canonical observation", async () => {
    let current = checkpoint(runGraph())
    let calls = 0
    const result = await runAIDataAutonomousControlLoop({
      checkpoint: {
        load: async () => current,
        commit: async (input) => {
          current = transitionAIDataAutonomousControlCheckpoint(current, input)
        },
      },
      verifier: {
        verify: async () => verifier("passed"),
      },
      controller: {
        decide: async ({ observation: observed }) => {
          calls += 1
          return calls === 1
            ? { value: { unsupported: true } }
            : { value: completionDecision(observed, verifier("passed")) as any }
        },
      },
    })

    expect(calls).toBe(2)
    expect(result.state).toMatchObject({
      phase: "completed",
      iteration: 2,
      receipts: [{ admissionKind: "rejected" }, { admissionKind: "complete" }],
    })
    expect((result.checkpoint.profile as any).runGraph.nodes.control.status).toBe("Succeeded")
  })

  it("propagates a host verifier identity failure without dispatching the controller or consuming an iteration", async () => {
    const original = checkpoint(runGraph())
    let controllerCalls = 0
    await expect(runAIDataAutonomousControlLoop({
      checkpoint: {
        load: async () => original,
        commit: async () => { throw new Error("commit must not run") },
      },
      verifier: {
        verify: async () => ({ ...verifier("passed"), verifierRef: "resource://fixture.wrong" }),
      },
      controller: {
        decide: async () => {
          controllerCalls += 1
          return { value: null }
        },
      },
    })).rejects.toThrow("immutable goal contract")
    expect(controllerCalls).toBe(0)
    expect(readAIDataAutonomousControlState(original).iteration).toBe(0)
  })
})
