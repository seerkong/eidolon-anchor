import { expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION as schemaVersion } from "ai-workflow-contract"
import { RESOURCE_AUTHORING_SCHEMA_VERSION } from "halfcode-compiler.xnl/authoring-runtime"
import { VirtualFileSystem } from "xnl-vfs"
import { EidolonAIAgentDefinitionAuthoringAdapter } from "../../src/resources/EidolonAIAgentDefinitionAuthoringAdapter"
import { EidolonAppResourceRegistryAdapter } from "../../src/resources/EidolonAppResourceRegistryAdapter"
import { EidolonAutonomousAgentResourceHost } from "../../src/resources/EidolonAutonomousAgentResourceHost"
import { openAuthoringTestRuntime } from "./fixtures/agent-authoring-process"
import { testSourceTsconfig } from "./fixtures/test-source-binding"

it("recovers original native revision admission after authoring succeeded and a successor was published", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-observation-recovery-"))
  const resourceRoot = path.join(root, "workspace/.eidolon/resources")
  await mkdir(path.dirname(resourceRoot), { recursive: true })
  await cp(path.join(import.meta.dir, "fixtures/resource-native-authoring-package"), resourceRoot, { recursive: true })
  const builtin = new VirtualFileSystem(); builtin.mkdir("vfs:///.eidolon/resources", { recursive: true })
  const input = { databasePath: path.join(root, "vfs.sqlite"), workspaceEidolonRoot: path.dirname(resourceRoot), supportRoot: path.join(root, "facts"), builtinSnapshot: builtin.getSnapshot() }
  const runtime = await openAuthoringTestRuntime(input)
  try {
    const initial = await runtime.materializer.materialize({ expectedCurrentRevision: runtime.materializer.read().snapshot.revision, overlays: await runtime.loadOverlays() })
    expect(initial.status).toBe("admitted")
    const host = new EidolonAutonomousAgentResourceHost(runtime.registry, [], input.supportRoot, runtime.authoring)
    const requirement = { schemaVersion, requirementId: "repair-worker", objective: "Repair a verified incomplete output", requiredToolRefs: [], requiredMaterialPortRefs: [], requiredMessageSourceRefs: [] }
    const target = { workflowKind: "AICtrlWorkflow" as const, workflowRef: "resource://eidolon.fixture.SummaryWorkflow" as const, nodeId: "summarize" }
    const observation = await host.observe(requirement)
    const candidate = observation.candidateSet.candidates[0]!
    const old = await host.prepare({ observation, target, decision: { schemaVersion, mode: "select-existing", candidateRef: candidate.agentDefinitionRef, candidateDigest: candidate.candidateDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest, requirementDigest: observation.requirement.requirementDigest, reason: "Original execution" } })
    expect(old.status).toBe("prepared"); if (old.status !== "prepared") throw Error("unreachable")
    const material = JSON.parse(JSON.stringify(await host.captureObservation(observation)))
    const before = await runtime.registry.snapshot()
    const v1 = await readFile(path.join(resourceRoot, "Agents/Summary.xnl"), "utf8")
    const decision = { schemaVersion, mode: "revise-existing" as const, candidateRef: candidate.agentDefinitionRef, candidateDigest: candidate.candidateDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest, requirementDigest: observation.requirement.requirementDigest,
      feedback: { observationRef: "observation://incomplete", attemptRef: "attempt://old", verificationRef: "verification://incomplete", requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest, candidateDigest: candidate.candidateDigest, previousExecutionFingerprint: old.taskBinding.semanticFingerprint },
      proposal: { schemaVersion: RESOURCE_AUTHORING_SCHEMA_VERSION, operation: "update" as const, catalogId: "agents", resourceId: "eidolon.fixture.SummaryAgent", kind: "AIAgentDefinition", envelopeVersion: "halfcode.resource-envelope/v1", writerSpecVersion: 1, sourceShape: "single-file" as const, documentUri: "vfs://@/Agents/Summary.xnl" as const, authorityText: v1.replace("Exact reusable summary Agent", "V2 repaired Worker"), expected: { state: "present" as const, authorityDigest: before.contentIdentities.get("eidolon.fixture.SummaryAgent")!.authorityDigest, registryRevision: before.registryRevision } }, reason: "Verified feedback revision" }
    const authoring = new EidolonAIAgentDefinitionAuthoringAdapter(runtime.registry, [], input.supportRoot, runtime.authoring)
    // This is the window under test: owner facts exist, final preparation does not.
    const v2 = await authoring.author({ proposal: decision.proposal })
    const v3 = await authoring.author({ proposal: { ...decision.proposal, authorityText: v1.replace("Exact reusable summary Agent", "V3 successor Worker"), expected: { state: "present", authorityDigest: v2.receipt.authorityDigestAfter, registryRevision: v2.receipt.registryRevisionAfter } } })
    const freshRuntime = await openAuthoringTestRuntime(input)
    try {
      const fresh = new EidolonAutonomousAgentResourceHost(freshRuntime.registry, [], input.supportRoot, freshRuntime.authoring)
      const restored = await fresh.restoreObservation(material)
      expect(restored.candidateSet).toEqual(observation.candidateSet)
      expect(await fresh.describeObservation(restored)).toEqual({ schemaVersion: "eidolon.agent-observation-description/v1", registryRevision: before.registryRevision,
        candidates: [{ agentDefinitionRef: candidate.agentDefinitionRef, resourceId: "eidolon.fixture.SummaryAgent", catalogId: "agents", documentUri: "vfs://@/Agents/Summary.xnl",
          authorityDigest: decision.proposal.expected.authorityDigest, authorityText: v1, envelopeVersion: "halfcode.resource-envelope/v1", writerSpecVersion: 1,
          kind: "AIAgentDefinition", sourceShape: "single-file" }] })
      const previousRegistry = await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(JSON.parse(JSON.stringify(old.frozenExecution)))
      const previousExecution = await previousRegistry.freezeWorkflowAgentTaskBinding(old.taskBinding.task)
      const recovered = await fresh.prepare({ observation: restored, target, decision: JSON.parse(JSON.stringify(decision)), previousExecution })
      expect(recovered.status).toBe("prepared"); if (recovered.status !== "prepared") throw Error("unreachable")
      expect(recovered.authoringReceipt).toEqual(v2.receipt)
      expect(recovered.admission.candidate.authoringEvidence?.revision?.feedback).toEqual(decision.feedback)
      expect(recovered.snapshot.registryRevision).toBe(v2.receipt.registryRevisionAfter)
      expect((await freshRuntime.registry.snapshot()).registryRevision).toBe(v3.receipt.registryRevisionAfter)
      expect(recovered.frozenExecution.files[".agent-resources/effective-vfs/.eidolon/resources/Opaque/baseline.bin"]).toBe(old.frozenExecution.files[".agent-resources/effective-vfs/.eidolon/resources/Opaque/baseline.bin"])
      const detached = await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(JSON.parse(JSON.stringify(recovered.frozenExecution)))
      expect((await detached.freezeWorkflowAgentTaskBinding(recovered.taskBinding.task)).semanticFingerprint).toBe(recovered.taskBinding.semanticFingerprint)
      const forged = structuredClone(material); forged.candidateSetDigest = "sha256:" + "0".repeat(64)
      await expect(fresh.restoreObservation(forged)).rejects.toThrow("OBSERVATION")
      const missingPublication = new EidolonAutonomousAgentResourceHost(freshRuntime.registry, [], input.supportRoot, { ...freshRuntime.authoring, lookupPublication: async () => undefined })
      await expect(missingPublication.prepare({ observation: await missingPublication.restoreObservation(material), target, decision, previousExecution })).rejects.toThrow("PUBLICATION_PROOF_UNAVAILABLE")
      const childInputPath = path.join(root, "fresh-recovery.json")
      await writeFile(childInputPath, JSON.stringify({ input, material, decision, target, previousBundle: old.frozenExecution, previousTask: old.taskBinding.task }))
      const child = Bun.spawn([process.execPath, "--tsconfig-override", testSourceTsconfig(), path.join(import.meta.dir, "fixtures/agent-observation-recovery-process.ts"), childInputPath], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(exitCode, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ receipt: v2.receipt, feedback: decision.feedback, originalRevision: v2.receipt.registryRevisionAfter,
        liveRevision: v3.receipt.registryRevisionAfter, fingerprint: recovered.taskBinding.semanticFingerprint, restoredFingerprint: recovered.taskBinding.semanticFingerprint })
    } finally { freshRuntime.authority.close() }
  } finally { runtime.authority.close(); await rm(root, { recursive: true, force: true }) }
}, 30_000)
