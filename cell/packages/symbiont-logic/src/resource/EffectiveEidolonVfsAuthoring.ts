import type { EidolonVfsPublicationAssociation, EidolonVfsPublicationRecord, EidolonVfsWorkspaceWrite } from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import type { EffectiveEidolonVfsCandidate, EffectiveEidolonVfsMaterializationResult, EffectiveEidolonVfsView, PrepareEffectiveEidolonVfsResult } from "./EffectiveEidolonVfsMaterializer"

export interface EidolonResourcePackageFile {
  readonly path: string
  readonly bytes: Uint8Array
}

/** The host owns the target and captures projection before-images. Callers supply intent only. */
export interface EidolonEffectiveVfsAuthoringPort {
  readonly workspaceResourceRoot: string
  read(): EffectiveEidolonVfsView
  prepare(input: Readonly<{
    expectedCurrentRevision: `sha256:${string}`
    logicalPath: `/.eidolon/resources/${string}`
    authorityText: string
  }>): Promise<PrepareEffectiveEidolonVfsResult>
  admit(candidate: EffectiveEidolonVfsCandidate, association?: EidolonVfsPublicationAssociation,
    workspaceWrite?: EidolonVfsWorkspaceWrite): Promise<EffectiveEidolonVfsMaterializationResult>
  /** Optional on legacy hosts; an absent capability must never fall back to direct filesystem writes. */
  preparePackage?(input: Readonly<{
    expectedCurrentRevision: `sha256:${string}`
    files: readonly EidolonResourcePackageFile[]
  }>): Promise<PrepareEffectiveEidolonVfsResult>
  admitPackage?(candidate: EffectiveEidolonVfsCandidate, association: EidolonVfsPublicationAssociation): Promise<EffectiveEidolonVfsMaterializationResult>
  lookupPublication?(transactionId: string): Promise<EidolonVfsPublicationRecord | undefined>
  restore?(): Promise<EffectiveEidolonVfsView>
}
