import type {
  CodumentPropositionManifest,
  CodumentPropositionMode,
  PropositionLiveEvidenceClass,
} from "./contract"

import { validatePropositionManifest } from "./harness"

export type CodumentPropositionMatrixSelection =
  | Readonly<{ kind: "deterministic" }>
  | Readonly<{ kind: "cell"; scenarioId: string; mode: CodumentPropositionMode }>
  | Readonly<{ kind: "sentinel" }>
  | Readonly<{ kind: "full" }>

export type CodumentPropositionMatrixCell = Readonly<{
  manifest: CodumentPropositionManifest
  mode: CodumentPropositionMode
}>

export type CodumentPropositionMatrixPlan = Readonly<{
  deterministic: boolean
  liveEvidence: "none" | PropositionLiveEvidenceClass
  cells: readonly CodumentPropositionMatrixCell[]
}>

export type CodumentPropositionMatrixCellResult = Readonly<{
  scenarioId: string
  mode: CodumentPropositionMode
  receiptRef: string
  status: "completed" | "failed"
}>

const MODE_ORDER: readonly CodumentPropositionMode[] = Object.freeze(["ordinary", "ai_ctrl", "ai_data"])

export function planCodumentPropositionMatrix(input: Readonly<{
  manifests: readonly CodumentPropositionManifest[]
  selection: CodumentPropositionMatrixSelection
  liveEvidence: "none" | PropositionLiveEvidenceClass
  sentinelScenarioIds: readonly string[]
}>): CodumentPropositionMatrixPlan {
  const manifests = input.manifests.map(validatePropositionManifest)
    .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId))
  const ids = manifests.map((manifest) => manifest.scenarioId)
  if (new Set(ids).size !== ids.length) throw new Error("proposition manifests must have unique scenarioId values")

  if (input.selection.kind === "deterministic") {
    return Object.freeze({ deterministic: true, liveEvidence: "none", cells: Object.freeze([]) })
  }
  if (input.liveEvidence !== "official" && input.liveEvidence !== "compatible") {
    throw new Error("live proposition cells require an explicit live evidence class")
  }

  let selected: readonly CodumentPropositionManifest[]
  if (input.selection.kind === "cell") {
    const selection = input.selection
    const manifest = manifests.find((candidate) => candidate.scenarioId === selection.scenarioId)
    if (!manifest) throw new Error(`unknown proposition scenario: ${selection.scenarioId}`)
    if (!manifest.allowedModes.includes(selection.mode)) {
      throw new Error(`mode ${selection.mode} is not allowed for ${manifest.scenarioId}`)
    }
    return Object.freeze({
      deterministic: false,
      liveEvidence: input.liveEvidence,
      cells: Object.freeze([{ manifest, mode: selection.mode }]),
    })
  }
  if (input.selection.kind === "sentinel") {
    const sentinels = new Set(input.sentinelScenarioIds)
    selected = manifests.filter((manifest) => sentinels.has(manifest.scenarioId))
    if (selected.length === 0) throw new Error("sentinel selection resolved no scenarios")
  } else {
    selected = manifests
  }

  const cells = selected.flatMap((manifest) => MODE_ORDER
    .filter((mode) => manifest.allowedModes.includes(mode))
    .map((mode) => Object.freeze({ manifest, mode })))
  return Object.freeze({ deterministic: false, liveEvidence: input.liveEvidence, cells: Object.freeze(cells) })
}

/**
 * Executes a frozen plan sequentially so each quota-consuming cell has a
 * recoverable receipt boundary. The callback is the only effect authority.
 */
export async function runCodumentPropositionMatrixPlan(input: Readonly<{
  plan: CodumentPropositionMatrixPlan
  completedCellKeys?: readonly string[]
  executeCell: (cell: CodumentPropositionMatrixCell) => Promise<Readonly<{
    receiptRef: string
    status: "completed" | "failed"
  }>>
}>): Promise<readonly CodumentPropositionMatrixCellResult[]> {
  if (input.plan.deterministic || input.plan.cells.length === 0) return Object.freeze([])
  if (input.plan.liveEvidence !== "official" && input.plan.liveEvidence !== "compatible") {
    throw new Error("matrix execution requires an explicit live-evidence plan")
  }
  const completed = new Set(input.completedCellKeys ?? [])
  const results: CodumentPropositionMatrixCellResult[] = []
  for (const cell of input.plan.cells) {
    const cellKey = `${cell.manifest.scenarioId}:${cell.mode}`
    if (completed.has(cellKey)) continue
    const result = await input.executeCell(cell)
    if (!result.receiptRef.trim()) throw new Error(`matrix cell ${cellKey} did not persist a receipt`)
    results.push(Object.freeze({
      scenarioId: cell.manifest.scenarioId,
      mode: cell.mode,
      receiptRef: result.receiptRef,
      status: result.status,
    }))
    if (result.status !== "completed") break
  }
  return Object.freeze(results)
}
