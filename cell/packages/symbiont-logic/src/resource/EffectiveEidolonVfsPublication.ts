import type { RevisionedVfsAuthority, RevisionedVfsSnapshot } from "xnl-vfs"
import type {
  EidolonVfsMaterializationPlan,
  EidolonVfsPublicationAssociation,
  EidolonVfsPublicationRecord,
  EidolonVfsValidationEvidence,
  EidolonVfsWorkspaceWrite,
} from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"

export interface EidolonVfsPublicationContext {
  readonly plan: EidolonVfsMaterializationPlan
  readonly validators: readonly EidolonVfsValidationEvidence[]
  readonly association?: EidolonVfsPublicationAssociation
  readonly workspaceWrite?: EidolonVfsWorkspaceWrite
}

/** One native revision owner; the scoped view only supplies metadata to its CAS. */
export interface EffectiveEidolonVfsPublicationAuthority extends RevisionedVfsAuthority {
  scopePublication(context: EidolonVfsPublicationContext): RevisionedVfsAuthority
  readHead(): Promise<RevisionedVfsSnapshot & { readonly publication?: EidolonVfsPublicationRecord }> | (RevisionedVfsSnapshot & { readonly publication?: EidolonVfsPublicationRecord })
  lookupPublication(key: string): Promise<EidolonVfsPublicationRecord | undefined> | EidolonVfsPublicationRecord | undefined
  recoverProjections(): Promise<void> | void
}

export function eidolonVfsPublicationKey(context: EidolonVfsPublicationContext): string {
  return context.association?.transactionId ?? context.plan.planId
}
