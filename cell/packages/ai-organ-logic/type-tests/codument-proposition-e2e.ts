import type {
  CodumentPropositionEffectRuntime,
  CodumentPropositionManifest,
  CodumentPropositionMode,
  PropositionCredentialBinding,
} from "../../../../testkit/codument-proposition/contract"
import {
  planCodumentPropositionMatrix,
  runCodumentPropositionMatrixPlan,
} from "../../../../testkit/codument-proposition/matrixRunner"
import { runCodumentPropositionCell } from "../../../../testkit/codument-proposition/harness"

declare const manifest: CodumentPropositionManifest
declare const runtime: CodumentPropositionEffectRuntime
declare const credential: PropositionCredentialBinding
declare const mode: CodumentPropositionMode

void runCodumentPropositionCell({
  manifest,
  mode,
  runtime,
  credential,
  eidolonExecutableDigest: `sha256:${"a".repeat(64)}`,
  codumentExecutableDigest: `sha256:${"b".repeat(64)}`,
})

const plan = planCodumentPropositionMatrix({
  manifests: [manifest],
  selection: { kind: "cell", scenarioId: manifest.scenarioId, mode },
  liveEvidence: "official",
  sentinelScenarioIds: [],
})

void runCodumentPropositionMatrixPlan({
  plan,
  executeCell: async () => ({ receiptRef: "artifact://receipt", status: "completed" }),
})
