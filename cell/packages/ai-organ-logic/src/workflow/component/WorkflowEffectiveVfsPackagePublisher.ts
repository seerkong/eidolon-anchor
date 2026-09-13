import { createHash } from "node:crypto"
import type { EidolonEffectiveVfsAuthoringPort } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsAuthoring"
import type { EidolonVfsPublicationAssociation } from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import { EidolonAppResourceRegistryAdapter } from "../../resources/EidolonAppResourceRegistryAdapter"
import {
  WorkflowAuthoringSessionStore, hashWorkflowBinaryFiles, workflowResourcePackagePublicationReceiptId, resourcePackageSnapshotResourceIds,
  type WorkflowResourcePackagePublicationReceipt,
} from "../authoring"
import {
  assertExactProofSnapshot, proofReceiptIds, WorkflowResourcePackagePublicationError,
  type WorkflowResourcePackagePublicationPreview, type WorkflowResourcePackagePublicationResult,
} from "./WorkflowResourcePackagePublisher"

type Attempt = {
  schemaVersion: "workflow.effective-publication-attempt/v1"
  association: EidolonVfsPublicationAssociation
  receipt: WorkflowResourcePackagePublicationReceipt
  files: { path: string; bytesBase64: string }[]
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

/** Draft storage holds recovery material; only the injected native authority decides publication. */
export class WorkflowEffectiveVfsPackagePublisher {
  constructor(
    private readonly sessions: WorkflowAuthoringSessionStore,
    private readonly registry: EidolonAppResourceRegistryAdapter,
    private readonly authority: EidolonEffectiveVfsAuthoringPort,
  ) {}

  async query(input: { sessionId: string; expectedRevision: string }) {
    const publicationId = `workflow-package:${digest([input.sessionId, input.expectedRevision])}`
    if (!this.authority.lookupPublication) throw new WorkflowResourcePackagePublicationError(
      "WORKFLOW_RESOURCE_PACKAGE_PUBLICATION_UNBOUND", "Publication lookup is not bound by the host.")
    const record = await this.authority.lookupPublication(publicationId)
    return { status: record ? "admitted" as const : "not_admitted" as const, publicationId,
      record: record ?? null, effectDispatched: false as const }
  }

  async publish(input: { sessionId: string; expectedRevision: string; confirmed: boolean }): Promise<WorkflowResourcePackagePublicationPreview | WorkflowResourcePackagePublicationResult> {
    if (!input.confirmed) return { status: "confirmation_required", sessionId: input.sessionId,
      revision: input.expectedRevision, publicationEffectDispatched: false, runtimeEffectDispatched: false }
    const authority = this.authority
    if (!authority.preparePackage || !authority.admitPackage || !authority.lookupPublication || !authority.restore) {
      throw new WorkflowResourcePackagePublicationError("WORKFLOW_RESOURCE_PACKAGE_PUBLICATION_UNBOUND", "The host has not bound complete package publication and recovery capabilities.")
    }
    const transactionId = `workflow-package:${digest([input.sessionId, input.expectedRevision])}`
    const journal = `.authoring/effective-publications/${digest(transactionId).slice(7)}.json`
    let admittedOrSubmitted = false
    return this.sessions.store.withExclusiveLock(`${journal}.lock`, async () => {
      const published = await authority.lookupPublication!(transactionId)
      if (published) {
        admittedOrSubmitted = true
        if (await this.sessions.store.kind(journal) !== "file") throw new Error("WORKFLOW_RESOURCE_PACKAGE_RECOVERY_MATERIAL_MISSING")
        const attempt = JSON.parse(await this.sessions.store.read(journal)) as Attempt
        if (attempt.schemaVersion !== "workflow.effective-publication-attempt/v1"
          || attempt.receipt.sessionId !== input.sessionId || attempt.receipt.sourceRevision !== input.expectedRevision
          || digest(attempt.receipt) !== published.association?.receiptDigest
          || JSON.stringify(attempt.association) !== JSON.stringify(published.association)
          || attempt.receipt.effectiveVfsRevision !== published.receipt.publishedRevision) {
          throw new Error("WORKFLOW_RESOURCE_PACKAGE_RECOVERY_INTEGRITY_MISMATCH")
        }
        const files = attempt.files.map(file => ({ path: file.path, bytes: new Uint8Array(Buffer.from(file.bytesBase64, "base64")) }))
        if (hashWorkflowBinaryFiles(files) !== attempt.receipt.artifactDigest) throw new Error("WORKFLOW_RESOURCE_PACKAGE_RECOVERY_BYTES_MISMATCH")
        await authority.restore!()
        await this.registry.refresh()
        let recoveryAuthority: object | undefined
        try {
          await this.sessions.findResourcePackagePublicationReceipt(input.sessionId, input.expectedRevision)
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH") throw error
          const recovery = await this.sessions.findRecoverableResourcePackagePublicationReceipt({
            sessionId: input.sessionId, sourceRevision: input.expectedRevision,
            baseArtifactRevision: attempt.receipt.baseArtifactRevision,
            baseRegistryRevision: attempt.receipt.baseRegistryRevision,
            createdAt: attempt.receipt.createdAt,
          })
          if (!recovery || recovery.receipt.receiptId !== attempt.receipt.receiptId) throw error
          recoveryAuthority = recovery.authority
        }
        const receipt = await this.sessions.recordResourcePackagePublication({ ...input, receipt: attempt.receipt, files, recoveryAuthority })
        return this.result(receipt)
      }

      const receipt = await this.sessions.withResourcePackagePublicationCandidate(input, async (candidate, finalize) => {
      const baseRevision = candidate.session.target.baseEffectiveVfsRevision as `sha256:${string}` | undefined
      if (!baseRevision) throw new Error("WORKFLOW_RESOURCE_PACKAGE_EFFECTIVE_BASE_MISSING")
      const prepared = await authority.preparePackage!({ expectedCurrentRevision: baseRevision, files: candidate.files })
      if (prepared.status !== "prepared") throw new WorkflowResourcePackagePublicationError(
        "WORKFLOW_RESOURCE_PACKAGE_PREPARE_REJECTED", JSON.stringify(prepared))
      const publication = await this.registry.withPublicationFence(async fence => {
        if (fence.currentSnapshot.registryRevision !== candidate.session.target.baseRegistryRevision) {
          throw new Error("WORKFLOW_RESOURCE_PACKAGE_BASE_REGISTRY_CONFLICT")
        }
        const loaded = await fence.loadCandidateSnapshot({ effectiveVfs: prepared.candidate.effective.readPort })
        const selected = resourcePackageSnapshotResourceIds(loaded.snapshot, candidate.session.target)
        const projection = await assertExactProofSnapshot(candidate.proofSet, loaded.snapshot, this.registry, selected)
        const payload: Omit<WorkflowResourcePackagePublicationReceipt, "receiptId"> = {
          kind: "workflow.resourcePackagePublicationReceipt", schemaVersion: "workflow.resource-package-publication-receipt/v1",
          sessionId: input.sessionId, sourceRevision: candidate.revision,
          baseArtifactRevision: candidate.session.target.baseArtifactRevision,
          baseRegistryRevision: candidate.session.target.baseRegistryRevision,
          baseEffectiveVfsRevision: baseRevision,
          effectiveVfsRevision: prepared.candidate.effective.snapshot.revision,
          packageId: candidate.session.target.packageId, packageVersion: candidate.session.target.packageVersion,
          artifactDigest: candidate.revision, compositionRevision: loaded.snapshot.registry.compositionRevision,
          registryRevision: loaded.snapshot.registryRevision, ...projection,
          proofReceiptIds: proofReceiptIds(candidate.proofSet), createdAt: new Date().toISOString(),
          publicationEffectDispatched: true, runtimeEffectDispatched: false,
        }
        const receipt = { ...payload, receiptId: workflowResourcePackagePublicationReceiptId(payload) }
        const association = { transactionId, planDigest: digest(prepared.candidate.plan), receiptDigest: digest(receipt) }
        const attempt: Attempt = { schemaVersion: "workflow.effective-publication-attempt/v1", association, receipt,
          files: candidate.files.map(file => ({ path: file.path, bytesBase64: Buffer.from(file.bytes).toString("base64") })) }
        await this.sessions.store.writeAtomic(journal, JSON.stringify(attempt))
        // The session lock holds work and its retained proofs through the native CAS.
        let admitted
        try {
          admittedOrSubmitted = true
          admitted = await authority.admitPackage!(prepared.candidate, association)
        } catch (cause) {
          const error = new WorkflowResourcePackagePublicationError("WORKFLOW_RESOURCE_PACKAGE_PUBLICATION_OUTCOME_UNKNOWN",
            `Publication ${transactionId} requires authority lookup and recovery before another attempt. ${cause instanceof Error ? cause.message : String(cause)}`)
          Object.assign(error, { publicationId: transactionId, publicationEffectDispatched: true, runtimeEffectDispatched: false })
          throw error
        }
        if (admitted.status !== "admitted") {
          admittedOrSubmitted = false
          throw new WorkflowResourcePackagePublicationError("WORKFLOW_RESOURCE_PACKAGE_ADMISSION_REJECTED", JSON.stringify(admitted))
        }
        return { candidate: loaded, value: receipt }
      })
      return finalize(publication.value)
      })
      return this.result(receipt)
    }, { orphanRecoveryEvidencePath: journal }).catch(cause => {
      if (!admittedOrSubmitted || (cause instanceof WorkflowResourcePackagePublicationError
        && cause.code === "WORKFLOW_RESOURCE_PACKAGE_PUBLICATION_OUTCOME_UNKNOWN")) throw cause
      const error = new WorkflowResourcePackagePublicationError("WORKFLOW_RESOURCE_PACKAGE_PUBLICATION_OUTCOME_UNKNOWN",
        `Publication ${transactionId} requires authority lookup and recovery. ${cause instanceof Error ? cause.message : String(cause)}`)
      Object.assign(error, { publicationId: transactionId, publicationEffectDispatched: true, runtimeEffectDispatched: false })
      throw error
    })
  }

  private result(receipt: WorkflowResourcePackagePublicationReceipt): WorkflowResourcePackagePublicationResult {
    return { status: "published", sessionId: receipt.sessionId, revision: receipt.sourceRevision,
      receipt, publicationEffectDispatched: true, runtimeEffectDispatched: false }
  }
}
