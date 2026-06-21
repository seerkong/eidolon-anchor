import { describe, expect, it } from "bun:test"
import fs from "fs"
import path from "path"

import {
  createActorControlOperation,
  createBlockedControlBarrier,
  createDurableHeadCohort,
  createSafeControlBarrier,
  isControlBarrierSafe,
  MAILBOX_WORK_CLASSES,
} from "../src"

describe("depa actor control primitives", () => {
  it("models control operations as serializable data", () => {
    const operation = createActorControlOperation({
      operationId: "op-1",
      kind: "mailbox.enqueue",
      target: { actorKey: "main", fiberId: "fiber-main" },
      causality: { causedBy: "external-input", parentOperationId: "op-0" },
      idempotencyKey: "fiber-main:mailbox.enqueue:1",
      expectedBarrier: { barrierId: "before-checkpoint", purpose: "checkpoint" },
      payload: { mailboxKind: "externalInput" },
    })

    expect(JSON.parse(JSON.stringify(operation))).toEqual(operation)
    expect(operation).not.toHaveProperty("execute")
    expect(operation).not.toHaveProperty("handler")
  })

  it("exports stable mailbox work classes", () => {
    expect(MAILBOX_WORK_CLASSES).toEqual([
      "recoverable_input",
      "mandatory_completion",
      "interrupt",
      "control_marker",
      "low_priority_continuation",
      "timer_wake",
    ])
  })

  it("returns bounded control barrier blockers", () => {
    const blocked = createBlockedControlBarrier({
      barrierId: "checkpoint-save",
      purpose: "checkpoint",
      blockers: [
        {
          participantId: "fiber-main",
          workClass: "mandatory_completion",
          phase: "wait",
          reason: "pending completion",
        },
      ],
    })
    const safe = createSafeControlBarrier({ barrierId: "checkpoint-save", purpose: "checkpoint" })

    expect(isControlBarrierSafe(blocked)).toBe(false)
    expect(isControlBarrierSafe(safe)).toBe(true)
    expect(JSON.stringify(blocked)).not.toContain("payload")
    expect(blocked.blockers[0]).toEqual({
      participantId: "fiber-main",
      workClass: "mandatory_completion",
      phase: "wait",
      reason: "pending completion",
    })
  })

  it("prevents durable head cohort advance while barrier is blocked", () => {
    const cohort = createDurableHeadCohort({
      cohortId: "durable-heads",
      barrierId: "checkpoint-save",
      heads: [
        { headId: "primary-state", kind: "state" },
        { headId: "secondary-index", kind: "projection" },
      ],
    })
    const blocked = createBlockedControlBarrier({
      barrierId: "checkpoint-save",
      purpose: "checkpoint",
      blockers: [{ participantId: "fiber-main", reason: "pending completion" }],
    })

    expect(cohort.heads.map((head) => head.headId)).toEqual(["primary-state", "secondary-index"])
    expect(cohort.canAdvance(blocked)).toBe(false)
    expect(cohort.canAdvance(createSafeControlBarrier({ barrierId: "checkpoint-save", purpose: "checkpoint" }))).toBe(true)
  })

  it("keeps the vendor package free of domain names", () => {
    const sourceDir = path.join(import.meta.dir, "..", "src")
    const packageJson = path.join(import.meta.dir, "..", "package.json")
    const files = fs.existsSync(sourceDir)
      ? fs.readdirSync(sourceDir).map((file) => path.join(sourceDir, file))
      : []
    const text = [packageJson, import.meta.path, ...files]
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, "utf-8"))
      .join("\n")
    const disallowed = [
      "A" + "I",
      "L" + "L" + "M",
      "too" + "l",
      "question" + "naire",
      "mem" + "ber",
      "dele" + "gate",
      "ho" + "lon",
    ]
    const pattern = new RegExp(`\\b(?:${disallowed.join("|")})\\b`, "i")

    expect(text).not.toMatch(pattern)
  })
})
