import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { assertCoordinatorDerivation } from "@cell/ai-core-contract"
import { coordinatorDerivation, runCoordinatorCapsule } from "../src/coordinatorCapsule/coreLogic"
import {
  registerCoordinatorWriterAdapter,
  resolveCoordinatorWriterAdapter,
} from "../src/coordinatorCapsule/adapterRegistry"

/**
 * Capsule structure conformance for the snapshot_coordinator cluster
 * (spec cases stable-core-logic-entry, adapters-wired-by-enum,
 * internals-not-imported, types-stay-in-contract) plus the decision
 * derivation's behavior.
 */

const packageRoot = path.resolve(import.meta.dir, "..")
const capsuleDir = path.join(packageRoot, "src/coordinatorCapsule")

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const collected: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collected.push(...listTsFiles(full))
    else if (entry.name.endsWith(".ts")) collected.push(full)
  }
  return collected
}

describe("coordinator capsule structure", () => {
  it("has the capsule layout: coreLogic, adapterRegistry", () => {
    expect(fs.existsSync(path.join(capsuleDir, "coreLogic.ts"))).toBe(true)
    expect(fs.existsSync(path.join(capsuleDir, "adapterRegistry.ts"))).toBe(true)
  })

  it("coreLogic exposes the stable (runtime, input, config) entry", () => {
    const source = fs.readFileSync(path.join(capsuleDir, "coreLogic.ts"), "utf8")
    expect(source).toMatch(/export async function runCoordinatorCapsule\s*\(\s*runtime\b/)
    expect(source).toMatch(/runCoordinatorCapsule\s*\(\s*runtime[^)]*\binput\b[^)]*\bconfig\b/s)
  })

  it("internals are not imported from outside the capsule", () => {
    const outside = listTsFiles(path.join(packageRoot, "src")).filter(
      (file) => !file.includes("coordinatorCapsule"),
    )
    for (const file of outside) {
      const content = fs.readFileSync(file, "utf8")
      expect(
        content.includes("coordinatorCapsule/internals"),
        `${file} must not import capsule internals`,
      ).toBe(false)
    }
  })

  it("derivation implementations stay IO-free (spec case derivation-is-pure)", () => {
    const source = fs.readFileSync(path.join(capsuleDir, "coreLogic.ts"), "utf8")
    const ioImports = (source.match(/^import .*$/gm) ?? []).filter((line) =>
      /node:fs|node:child_process|node:net|node:http/.test(line),
    )
    expect(ioImports).toEqual([])
    for (const pattern of ["fetch(", "process.env"]) {
      expect(source.includes(pattern), `coreLogic.ts must not contain ${pattern}`).toBe(false)
    }
  })

  it("types stay in the contract package: the capsule defines no contract-named types", () => {
    for (const file of listTsFiles(capsuleDir)) {
      const content = fs.readFileSync(file, "utf8")
      const localTypes = content.match(/export (?:type|interface) (Coordinator\w+|AiRuntime\w+)\b/g)
      expect(localTypes, `${file} must not redefine contract types`).toBeNull()
    }
  })
})

describe("coordinator derivation decisions", () => {
  const derivation = assertCoordinatorDerivation(coordinatorDerivation)

  it("decides skip reasons in the declared priority order: storage, safepoint, pending effects", () => {
    expect(
      derivation.decideCheckpointAction({
        storageFilesEnabled: false,
        safepointSafe: false,
        pendingEffectIds: ["op-1"],
      }),
    ).toEqual({ action: "skip", reason: "skipped_storage_disabled" })

    expect(
      derivation.decideCheckpointAction({
        storageFilesEnabled: true,
        safepointSafe: false,
        pendingEffectIds: ["op-1"],
      }),
    ).toEqual({ action: "skip", reason: "skipped_non_safepoint" })

    expect(
      derivation.decideCheckpointAction({
        storageFilesEnabled: true,
        safepointSafe: true,
        pendingEffectIds: ["op-1"],
      }),
    ).toEqual({ action: "skip", reason: "skipped_pending_effects" })

    expect(
      derivation.decideCheckpointAction({
        storageFilesEnabled: true,
        safepointSafe: true,
        pendingEffectIds: [],
      }),
    ).toEqual({ action: "save" })
  })

  it("decideRecovery keeps the pending-effects recovery semantics", () => {
    const recoverable = derivation.decideRecovery({
      recovery: {
        classification: "pending",
        blockers: [{ reason: "effect_pending", effectId: "op-1" }],
      } as never,
      recoveredInflights: [{ opId: "op-1" }] as never,
    })
    expect(recoverable.recoverable).toBe(true)

    const dangling = derivation.decideRecovery({
      recovery: {
        classification: "pending",
        blockers: [{ reason: "effect_pending", effectId: "op-x" }],
      } as never,
      recoveredInflights: [] as never,
    })
    expect(dangling.recoverable).toBe(false)
    expect(dangling.danglingEffectIds).toEqual(["op-x"])
  })
})

describe("coordinator capsule wiring", () => {
  it("writer adapters are wired by enum id through the registry", () => {
    const writer = async () => ({ status: "saved" as const })
    registerCoordinatorWriterAdapter("in_memory", writer)
    expect(resolveCoordinatorWriterAdapter("in_memory")).toBe(writer)
    expect(() => resolveCoordinatorWriterAdapter("no_such_writer" as never)).toThrow(/no_such_writer/)
  })

  it("a skip decision returns without touching the writer; save runs it", async () => {
    let writes = 0
    registerCoordinatorWriterAdapter("in_memory", async () => {
      writes += 1
      return { status: "saved" as const }
    })

    const skipped = await runCoordinatorCapsule(
      {},
      {
        decision: { storageFilesEnabled: false, safepointSafe: true, pendingEffectIds: [] },
        writeRequest: { sessionDir: "/tmp/none", idempotencyKey: "k", writeConcreteCheckpoint: async () => ({}) },
      },
      { writerAdapter: "in_memory" },
    )
    expect(skipped.decision).toEqual({ action: "skip", reason: "skipped_storage_disabled" })
    expect(writes).toBe(0)

    const saved = await runCoordinatorCapsule(
      {},
      {
        decision: { storageFilesEnabled: true, safepointSafe: true, pendingEffectIds: [] },
        writeRequest: { sessionDir: "/tmp/none", idempotencyKey: "k", writeConcreteCheckpoint: async () => ({}) },
      },
      { writerAdapter: "in_memory" },
    )
    expect(saved.decision).toEqual({ action: "save" })
    expect(writes).toBe(1)
  })
})
