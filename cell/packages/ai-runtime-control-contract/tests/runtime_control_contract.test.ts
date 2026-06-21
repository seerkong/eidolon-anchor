import { describe, expect, it } from "bun:test"

import {
  AI_TURN_BARRIER_CONSUMERS,
  AI_TURN_BARRIER_REASONS,
  AI_CONTROL_OPERATION_KINDS,
  AI_RUNTIME_CONTROL_COMMAND_KINDS,
  AI_RUNTIME_CONTROL_COMMAND_QUEUES,
  AI_RUNTIME_EFFECT_STATUSES,
  AI_RUNTIME_EFFECT_KINDS,
  AI_RUNTIME_REAL_SESSION_HEADS,
  AI_RUNTIME_RECOVERY_CLASSES,
  type AiTurnBarrierConsumer,
  type AiTurnBarrierResult,
  type AiControlOperation,
  type AiDurableHeadCohort,
  type AiRuntimeControlCommand,
  type AiRuntimeControlPorts,
  type AiRuntimeControlState,
  type AiRuntimeEffectLifecycleEvent,
  type AiRuntimeSessionHeadDescriptor,
} from "../src"

describe("AI runtime control contract", () => {
  it("exports reusable turn barrier consumers", () => {
    expect(AI_TURN_BARRIER_CONSUMERS).toEqual([
      "snapshot_save",
      "idle_preemption",
      "heartbeat_eligibility",
      "recovery_scheduling",
      "tui_settled",
    ])
    const consumer: AiTurnBarrierConsumer = "snapshot_save"
    expect(consumer).toBe("snapshot_save")
  })

  it("models bounded AI turn barrier results", () => {
    const result: AiTurnBarrierResult = {
      safe: false,
      barrierId: "snapshot-save",
      purpose: "snapshot_save",
      blockers: [
        {
          participantId: "fiber-main",
          fiberId: "fiber-main",
          actorKey: "main",
          phase: "wait_llm",
          workClass: "mandatory_completion",
          reason: "pending_mailbox_work",
          mailboxKinds: ["asyncCompletion"],
        },
      ],
    }

    expect(AI_TURN_BARRIER_REASONS).toContain("pending_mailbox_work")
    expect(JSON.stringify(result)).not.toContain("payload")
  })

  it("models AI control operations without implementation handlers", () => {
    const operation: AiControlOperation<{ text: string }> = {
      operationId: "op-human-input",
      kind: "human_input",
      target: { actorKey: "main", fiberId: "fiber-main" },
      idempotencyKey: "fiber-main:human-input:1",
      payload: { text: "continue" },
    }

    expect(AI_CONTROL_OPERATION_KINDS).toContain("human_input")
    expect(JSON.parse(JSON.stringify(operation))).toEqual(operation)
    expect(operation).not.toHaveProperty("execute")
  })

  it("models AI durable head cohorts", () => {
    const cohort: AiDurableHeadCohort = {
      cohortId: "runtime-snapshot",
      barrierId: "snapshot-save",
      heads: [
        { headId: "runtime_state", kind: "runtime_snapshot" },
        { headId: "conversation", kind: "conversation_head" },
      ],
    }

    expect(cohort.heads.map((head) => head.kind)).toEqual(["runtime_snapshot", "conversation_head"])
  })

  it("models runtime control engine commands as serializable data", () => {
    const commands: AiRuntimeControlCommand[] = [
      { kind: "effect_request", commandId: "cmd-1", effectId: "effect-1", handlerKey: "bash" },
      { kind: "effect_result", commandId: "cmd-2", effectId: "effect-1", resultId: "result-1" },
      { kind: "durable_head_buffer", commandId: "cmd-3", headId: "conversation", sequence: 2 },
      { kind: "safepoint_evaluate", commandId: "cmd-4", cohortId: "turn", reason: "manual" },
      { kind: "cohort_commit", commandId: "cmd-5", cohortId: "turn" },
    ]

    expect(AI_RUNTIME_CONTROL_COMMAND_KINDS).toEqual([
      "effect_request",
      "effect_result",
      "durable_head_buffer",
      "safepoint_evaluate",
      "cohort_commit",
    ])
    expect(AI_RUNTIME_CONTROL_COMMAND_QUEUES).toEqual(["effectResult", "safepoint", "commit", "normal"])
    expect(JSON.parse(JSON.stringify(commands))).toEqual(commands)
    expect(commands[0]).not.toHaveProperty("execute")
  })

  it("models effect lifecycle, recovery classes, and explicit effect ports", () => {
    const state: AiRuntimeControlState<{ sequence: number }> = {
      commands: { sequence: 0 },
      runtime: {
        persistence: {
          effects: {
            "effect-1": {
              effectId: "effect-1",
              handlerKey: "bash",
              status: "requested",
              requestSeen: true,
              resultSeen: false,
            },
          },
          heads: {
            conversation: {
              headId: "conversation",
              kind: "conversation_head",
              committedSequence: 1,
            },
          },
          cohorts: {
            turn: {
              cohortId: "turn",
              headIds: ["conversation"],
              status: "open",
            },
          },
        },
        recovery: {
          classification: "pending",
        },
      },
    }
    const ports: AiRuntimeControlPorts = {
      effects: {
        hasHandler: (handlerKey) => handlerKey === "bash",
        dispatchEffect: async (request) => ({
          effectId: request.effectId,
          resultId: `${request.effectId}:result`,
        }),
      },
      durableHeads: {
        bufferHead: async () => {},
        commitCohort: async (cohort) => `${cohort.cohortId}:marker`,
      },
    }

    expect(AI_RUNTIME_EFFECT_STATUSES).toContain("orphaned")
    expect(AI_RUNTIME_RECOVERY_CLASSES).toEqual(["clean", "pending", "retryable", "orphaned", "dirty"])
    expect(state.runtime.recovery.classification).toBe("pending")
    expect(JSON.stringify(Object.keys(state))).toBe(JSON.stringify(["commands", "runtime"]))
    expect(ports.effects.hasHandler("bash")).toBe(true)
  })

  it("models real session durable head descriptors without file IO implementations", () => {
    const descriptors: AiRuntimeSessionHeadDescriptor[] = AI_RUNTIME_REAL_SESSION_HEADS

    expect(descriptors.map((head) => head.headId)).toEqual([
      "runtime_snapshot",
      "conversation",
      "mailbox",
      "control_signals",
      "ingress_log",
      "diagnostics_log",
    ])
    expect(descriptors.find((head) => head.headId === "runtime_snapshot")).toEqual({
      headId: "runtime_snapshot",
      kind: "runtime_snapshot",
      source: "snapshot",
      sequenceStrategy: "manifest_version",
      requiredForCheckpoint: true,
    })
    expect(descriptors.some((head) => head.headId === "actor_transcript")).toBe(false)
    expect(descriptors.find((head) => head.headId === "ingress_log")?.requiredForCheckpoint).toBe(false)
    expect(descriptors.find((head) => head.headId === "diagnostics_log")?.requiredForCheckpoint).toBe(false)
    expect(descriptors.find((head) => head.headId === "ingress_log")?.sequenceStrategy).toBe("event_count")
    expect(descriptors.find((head) => head.headId === "diagnostics_log")?.sequenceStrategy).toBe("event_count")
    expect(JSON.stringify(descriptors)).not.toContain("writeFile")
    expect(JSON.stringify(descriptors)).not.toContain("readFile")
    expect(JSON.stringify(descriptors)).not.toContain("append_offset")
  })

  it("models real runtime effect lifecycle events with idempotency keys", () => {
    const events: AiRuntimeEffectLifecycleEvent[] = [
      {
        kind: "request",
        effectKind: "mcp_tool",
        effectId: "effect-mcp-1",
        handlerKey: "mcp:filesystem.read",
        idempotencyKey: "fiber-main:tool-call-1",
        sourceCommandId: "cmd-1",
      },
      {
        kind: "waiting",
        effectKind: "permission",
        effectId: "effect-permission-1",
        handlerKey: "permission:local",
        idempotencyKey: "fiber-main:permission-1",
        waitReason: "requires_user_approval",
      },
      {
        kind: "result",
        effectKind: "provider_completion",
        effectId: "effect-llm-1",
        handlerKey: "provider:openai",
        resultId: "result-llm-1",
      },
    ]

    expect(AI_RUNTIME_EFFECT_KINDS).toEqual([
      "tool_call",
      "mcp_tool",
      "bash",
      "permission",
      "questionnaire",
      "provider_completion",
      "runtime_checkpoint",
    ])
    expect(events.every((event) => event.effectId.length > 0)).toBe(true)
    expect(events[0]).toHaveProperty("idempotencyKey", "fiber-main:tool-call-1")
    expect(JSON.parse(JSON.stringify(events))).toEqual(events)
  })
})
