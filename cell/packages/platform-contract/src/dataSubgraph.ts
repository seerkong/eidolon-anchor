/**
 * Domain-neutral data subgraph contracts.
 *
 * A data subgraph contract declares, for one data component, which fact nodes
 * it owns, which derived nodes it materializes, and which read/write
 * boundaries other components must respect. Domain kernels declare concrete
 * components on top of this shape; the platform layer only provides the
 * machinery and the fact-grade ladder.
 */

export const DATA_FACT_GRADES = [
  "authoritative_fact",
  "domain_canonical_event",
  "runtime_control_fact",
  "append_only_journal",
  "checkpoint_snapshot",
  "derived_projection_cache",
  "surface_view",
  "legacy_mixed",
] as const

export type DataFactGrade = (typeof DATA_FACT_GRADES)[number]

/**
 * Grades that a live loop is allowed to treat as truth. Journals, checkpoint
 * snapshots, projections, surface views, and legacy mixed state may only be
 * observed, replayed in explicit recovery, or rebuilt — never read as live
 * truth.
 */
export const LIVE_TRUTH_CAPABLE_FACT_GRADES = [
  "authoritative_fact",
  "domain_canonical_event",
  "runtime_control_fact",
] as const satisfies readonly DataFactGrade[]

export type LiveTruthCapableFactGrade = (typeof LIVE_TRUTH_CAPABLE_FACT_GRADES)[number]

export function isLiveTruthCapableFactGrade(grade: DataFactGrade): grade is LiveTruthCapableFactGrade {
  return (LIVE_TRUTH_CAPABLE_FACT_GRADES as readonly DataFactGrade[]).includes(grade)
}

export type DataSubgraphLayer = "platform" | "domain" | "app_overlay" | "surface"

export type DataNodeDeclaration = {
  nodeId: string
  grade: DataFactGrade
  description?: string
}

export type DataSubgraphContract = {
  id: string
  layer: DataSubgraphLayer
  /** Fact nodes this component is the single writer for. */
  ownedFactNodes: DataNodeDeclaration[]
  /** Nodes rebuildable from owned facts; never a recovery source. */
  derivedNodes: DataNodeDeclaration[]
  /** Commands that enter this component's reducer; the only write boundary. */
  writeCommands: string[]
  /** Readonly views exposed to other components. */
  readViews: string[]
  /** Fact or canonical-event streams other components may subscribe to. */
  factStreams: string[]
  /** Projections/journals allowed to observe this component. */
  projectionSinks: string[]
  /** Explicit negative ownership: nodes this component must never own. */
  notOwnedHere: string[]
  /** Nodes this component may read during explicit recovery only. */
  allowedRecoveryReads: string[]
  /** Nodes this component must never read during live operation. */
  forbiddenLiveReads: string[]
}

export type DataSubgraphContractRegistry = {
  contracts: readonly DataSubgraphContract[]
  getContract: (componentId: string) => DataSubgraphContract | null
  /** Owner lookup across owned fact nodes; derived nodes have no owner entry. */
  findOwnerOfFactNode: (nodeId: string) => string | null
  /** Grade of a node, whether owned or derived. */
  classifyFactNode: (nodeId: string) => DataFactGrade | null
  /** Grade-based: only live-truth capable nodes may be read as live truth. */
  isAllowedLiveRead: (nodeId: string) => boolean
  isAllowedRecoveryRead: (componentId: string, nodeId: string) => boolean
  isForbiddenLiveRead: (componentId: string, nodeId: string) => boolean
  isWriteCommandOwnedBy: (componentId: string, command: string) => boolean
}

export function createDataSubgraphContractRegistry(
  contracts: DataSubgraphContract[],
): DataSubgraphContractRegistry {
  const byId = new Map<string, DataSubgraphContract>()
  const ownerByNode = new Map<string, string>()
  const gradeByNode = new Map<string, DataFactGrade>()

  for (const contract of contracts) {
    if (byId.has(contract.id)) {
      throw new Error(`duplicate data subgraph contract id: ${contract.id}`)
    }
    byId.set(contract.id, contract)

    const notOwned = new Set(contract.notOwnedHere)
    for (const node of contract.ownedFactNodes) {
      if (notOwned.has(node.nodeId)) {
        throw new Error(
          `component ${contract.id} owns node ${node.nodeId} but also declares it notOwnedHere (not-owned-here contradiction)`,
        )
      }
      const existingOwner = ownerByNode.get(node.nodeId)
      if (existingOwner) {
        throw new Error(
          `fact node ${node.nodeId} already owned by ${existingOwner}; second owner ${contract.id} is not allowed`,
        )
      }
      ownerByNode.set(node.nodeId, contract.id)
      gradeByNode.set(node.nodeId, node.grade)
    }
    for (const node of contract.derivedNodes) {
      if (!gradeByNode.has(node.nodeId)) gradeByNode.set(node.nodeId, node.grade)
    }
  }

  return {
    contracts,
    getContract: (componentId) => byId.get(componentId) ?? null,
    findOwnerOfFactNode: (nodeId) => ownerByNode.get(nodeId) ?? null,
    classifyFactNode: (nodeId) => gradeByNode.get(nodeId) ?? null,
    isAllowedLiveRead: (nodeId) => {
      const grade = gradeByNode.get(nodeId)
      return grade ? isLiveTruthCapableFactGrade(grade) : false
    },
    isAllowedRecoveryRead: (componentId, nodeId) =>
      byId.get(componentId)?.allowedRecoveryReads.includes(nodeId) ?? false,
    isForbiddenLiveRead: (componentId, nodeId) =>
      byId.get(componentId)?.forbiddenLiveReads.includes(nodeId) ?? false,
    isWriteCommandOwnedBy: (componentId, command) =>
      byId.get(componentId)?.writeCommands.includes(command) ?? false,
  }
}
