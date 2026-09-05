import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

import { holonMemberRuntimeIsolationForBindingPolicy } from "../../src/organization/HolonCoordinator"
import { holonMemberRuntimeRef } from "../../src/organization/HolonMemberRuntime"

describe("Holon task MemberRuntime policy", () => {
  it("derives shared or task-space isolation only from the frozen binding policy", () => {
    const sharedA = holonMemberRuntimeIsolationForBindingPolicy(
      "shared-member-runtime",
      "task-space:a",
    )
    const sharedB = holonMemberRuntimeIsolationForBindingPolicy(
      "shared-member-runtime",
      "task-space:b",
    )
    const isolatedA = holonMemberRuntimeIsolationForBindingPolicy(
      "isolated-task-runtime",
      "task-space:a",
    )
    const isolatedB = holonMemberRuntimeIsolationForBindingPolicy(
      "isolated-task-runtime",
      "task-space:b",
    )

    expect(sharedA).toEqual({ mode: "shared" })
    expect(sharedB).toEqual({ mode: "shared" })
    expect(isolatedA).toEqual({
      mode: "isolated",
      scope: "task-space",
      isolationKey: "task-space:a",
    })
    expect(holonMemberRuntimeRef({
      deploymentId: "deployment:review",
      memberRef: "member:reviewer",
      runtime: sharedA,
    })).toBe(holonMemberRuntimeRef({
      deploymentId: "deployment:review",
      memberRef: "member:reviewer",
      runtime: sharedB,
    }))
    expect(holonMemberRuntimeRef({
      deploymentId: "deployment:review",
      memberRef: "member:reviewer",
      runtime: isolatedA,
    })).not.toBe(holonMemberRuntimeRef({
      deploymentId: "deployment:review",
      memberRef: "member:reviewer",
      runtime: isolatedB,
    }))
  })

  it("keeps generic conversation content outside TaskSpace and support state", async () => {
    const support = await readFile(
      new URL("../../../ai-support/src/organization/LocalHolonTaskRuntimeSupport.ts", import.meta.url),
      "utf8",
    )
    const profile = await readFile(
      new URL("../../src/organization/HolonTaskExecutionProfile.ts", import.meta.url),
      "utf8",
    )

    expect(support).not.toMatch(/actor\.messages|conversationHistory|providerMessages/)
    expect(profile).not.toMatch(/actor\.messages|conversationHistory|providerMessages/)
    expect(profile).toContain("snapshotReceipt")
  })
})
