import { describe, expect, it } from "bun:test"

import type { CodumentPropositionManifest } from "../../../../../testkit/codument-proposition/contract"
import {
  planCodumentPropositionMatrix,
  runCodumentPropositionMatrixPlan,
} from "../../../../../testkit/codument-proposition/matrixRunner"

const SHA = `sha256:${"a".repeat(64)}` as const

function manifest(scenarioId: string): CodumentPropositionManifest {
  return {
    schemaVersion: "eidolon.codument-proposition-manifest/v1",
    scenarioId,
    revision: "1",
    corpusDigest: SHA,
    sources: [
      { relativePath: `${scenarioId}/request.md`, digest: SHA, role: "request" },
      { relativePath: `${scenarioId}/verify.sh`, digest: SHA, role: "verifier" },
    ],
    requestComposition: [`${scenarioId}/request.md`],
    verifier: { argv: ["bash", `${scenarioId}/verify.sh`], digest: SHA },
    workspaceSeed: "empty_git",
    timeoutSeconds: 3_600,
    allowedModes: ["ordinary", "ai_ctrl", "ai_data"],
  }
}

describe("Codument proposition matrix planning", () => {
  const manifests = [manifest("sentinel"), manifest("full-only")]

  it("selects one explicit cell without enabling a matrix", () => {
    expect(planCodumentPropositionMatrix({
      manifests,
      selection: { kind: "cell", scenarioId: "full-only", mode: "ai_data" },
      liveEvidence: "official",
      sentinelScenarioIds: ["sentinel"],
    }).cells.map((cell) => `${cell.manifest.scenarioId}:${cell.mode}`)).toEqual(["full-only:ai_data"])
  })

  it("preserves an explicit compatible evidence class across a sentinel plan", () => {
    const plan = planCodumentPropositionMatrix({
      manifests,
      selection: { kind: "sentinel" },
      liveEvidence: "compatible",
      sentinelScenarioIds: ["sentinel"],
    })
    expect(plan.liveEvidence).toBe("compatible")
    expect(plan.cells.map((cell) => cell.mode)).toEqual(["ordinary", "ai_ctrl", "ai_data"])
  })

  it("selects sentinel and full matrices in stable scenario/mode order", () => {
    const sentinel = planCodumentPropositionMatrix({
      manifests,
      selection: { kind: "sentinel" },
      liveEvidence: "official",
      sentinelScenarioIds: ["sentinel"],
    })
    expect(sentinel.cells.map((cell) => `${cell.manifest.scenarioId}:${cell.mode}`)).toEqual([
      "sentinel:ordinary",
      "sentinel:ai_ctrl",
      "sentinel:ai_data",
    ])

    const full = planCodumentPropositionMatrix({
      manifests: [...manifests].reverse(),
      selection: { kind: "full" },
      liveEvidence: "official",
      sentinelScenarioIds: ["sentinel"],
    })
    expect(full.cells).toHaveLength(6)
    expect(full.cells[0]?.manifest.scenarioId).toBe("full-only")
    expect(full.cells[5]?.mode).toBe("ai_data")
  })

  it("never schedules quota-consuming sentinel/full work without an explicit live evidence class", () => {
    expect(() => planCodumentPropositionMatrix({
      manifests,
      selection: { kind: "sentinel" },
      liveEvidence: "none",
      sentinelScenarioIds: ["sentinel"],
    })).toThrow("explicit live evidence class")
    expect(() => planCodumentPropositionMatrix({
      manifests,
      selection: { kind: "full" },
      liveEvidence: "none",
      sentinelScenarioIds: ["sentinel"],
    })).toThrow("explicit live evidence class")
  })

  it("provides a deterministic fixture plan without live provider cells", () => {
    const plan = planCodumentPropositionMatrix({
      manifests,
      selection: { kind: "deterministic" },
      liveEvidence: "none",
      sentinelScenarioIds: ["sentinel"],
    })
    expect(plan.cells).toEqual([])
    expect(plan.deterministic).toBeTrue()
  })

  it("executes cells through one injected effect, resumes receipts and stops at the first failure", async () => {
    const plan = planCodumentPropositionMatrix({
      manifests,
      selection: { kind: "full" },
      liveEvidence: "official",
      sentinelScenarioIds: ["sentinel"],
    })
    const calls: string[] = []
    const results = await runCodumentPropositionMatrixPlan({
      plan,
      completedCellKeys: ["full-only:ordinary"],
      executeCell: async (cell) => {
        const key = `${cell.manifest.scenarioId}:${cell.mode}`
        calls.push(key)
        return {
          receiptRef: `artifact://${key}`,
          status: key === "full-only:ai_data" ? "failed" : "completed",
        }
      },
    })
    expect(calls).toEqual(["full-only:ai_ctrl", "full-only:ai_data"])
    expect(results.at(-1)).toMatchObject({ status: "failed", mode: "ai_data" })
  })
})
