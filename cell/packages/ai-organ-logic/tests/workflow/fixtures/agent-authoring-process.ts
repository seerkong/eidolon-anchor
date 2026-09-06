import path from "node:path"
import { readFile } from "node:fs/promises"
import type { DataElementNode } from "xnl-core"
import type { EidolonVfsPublicationRecord } from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import type { ResourceAuthoringProposal } from "halfcode-compiler.xnl/authoring-runtime"
import { LocalFileEffectiveEidolonVfsAuthority } from "@cell/ai-support/runtime/LocalFileEffectiveEidolonVfsAuthority"
import {
  EffectiveEidolonVfsMaterializer, createMutationEidolonOverlay,
  loadPhysicalEidolonDirectoryOverlay, stableEidolonOverlayNodeId,
} from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"
import { EidolonAIAgentDefinitionAuthoringAdapter, type EidolonEffectiveVfsAuthoringPort } from "../../../src/resources/EidolonAIAgentDefinitionAuthoringAdapter"
import { EidolonAppResourceRegistryAdapter } from "../../../src/resources/EidolonAppResourceRegistryAdapter"

export interface AuthoringProcessInput {
  databasePath: string
  workspaceEidolonRoot: string
  supportRoot: string
  builtinSnapshot: DataElementNode
  proposal?: ResourceAuthoringProposal
  planDigest?: string
  interruptAfterAdmission?: boolean
}

export async function openAuthoringTestRuntime(input: AuthoringProcessInput, afterCommit?: (record: EidolonVfsPublicationRecord) => void) {
  const authority = new LocalFileEffectiveEidolonVfsAuthority({ ...input, afterCommit })
  const materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: input.builtinSnapshot, authority })
  await materializer.restore()
  const loadOverlays = () => Promise.all([loadPhysicalEidolonDirectoryOverlay({
    id: "workspace-directory", kind: "workspace", order: 0, rootDir: input.workspaceEidolonRoot,
  })])
  const authoring: EidolonEffectiveVfsAuthoringPort = {
    workspaceResourceRoot: path.join(input.workspaceEidolonRoot, "resources"),
    read: () => materializer.read(),
    async prepare(proposal) {
      const overlays = await loadOverlays()
      const baseline = await materializer.prepare({ expectedCurrentRevision: proposal.expectedCurrentRevision, overlays })
      if (baseline.status !== "prepared") return baseline
      if (baseline.candidate.effective.snapshot.revision !== materializer.read().snapshot.revision) throw new Error("TEST_OVERLAY_SOURCE_DRIFT")
      const existing = await baseline.candidate.effective.readPort.stat(proposal.logicalPath)
      return materializer.prepare({
        expectedCurrentRevision: proposal.expectedCurrentRevision,
        overlays: [...overlays, createMutationEidolonOverlay({
          id: "workspace-authoring-intent", kind: "workspace", order: 1,
          mutations: [{ type: existing ? "CONTENT_UPDATE" : "FILE_CREATE", path: `vfs://${proposal.logicalPath}`,
            expectedId: existing?.nodeId ?? stableEidolonOverlayNodeId("workspace-directory", "file", proposal.logicalPath),
            payload: { content: proposal.authorityText, fileType: "xnl" } }],
        })],
      })
    },
    admit: (...args) => materializer.admit(...args),
    lookupPublication: (key) => materializer.lookupPublication(key),
    restore: () => materializer.restore(),
  }
  const registry = new EidolonAppResourceRegistryAdapter({ effectiveVfs: () => materializer.read().readPort })
  return { authority, materializer, authoring, registry, loadOverlays }
}

if (import.meta.main) {
  const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as AuthoringProcessInput
  const runtime = await openAuthoringTestRuntime(input)
  const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(runtime.registry, [], input.supportRoot, runtime.authoring, {
    afterEffectiveVfsAdmission() {
      if (input.interruptAfterAdmission) process.kill(process.pid, "SIGKILL")
    },
  })
  try {
    const receipt = input.proposal ? (await adapter.author({ proposal: input.proposal })).receipt : await adapter.loadReceipt(input.planDigest!)
    process.stdout.write(JSON.stringify({ receipt, currentRevision: (await runtime.registry.snapshot()).registryRevision }))
  } finally { runtime.authority.close() }
}
