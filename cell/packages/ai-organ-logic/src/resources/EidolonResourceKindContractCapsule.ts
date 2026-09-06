import {
  HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1,
} from "@cell/ai-organ-contract"
import {
  HOLON_EFFECTIVE_SNAPSHOT_KIND_OWNER,
  HOLON_EFFECTIVE_SNAPSHOT_KIND_SPEC_REVISION_V1,
} from "holarchy-core-contract"
import {
  HOLON_EXECUTION_BINDING_KIND_OWNER,
  HOLON_EXECUTION_BINDING_KIND_READER_REGISTRATION_V1,
  HOLON_EXECUTION_BINDING_KIND_SPEC_REVISION_V1,
} from "holarchy-eidolon-adapter"
import {
  createAIWorkflowResourceResolutionContext,
  type AIWorkflowResourceResolutionContext,
} from "ai-workflow-logic/filesystem"
import {
  digestCanonical,
  type AuthoredResourceTree,
  type KindReaderRegistration,
  type PortableSpec,
} from "halfcode-compiler.xnl/resource-core"
import { createReaderProfile } from "halfcode-compiler.xnl/kind-definition"

import { HOLON_TASK_RUNTIME_DEFINITION_KIND_READER_REGISTRATION_V1 } from "../organization/HolonTaskRuntimeContract"

export const EIDOLON_RESOURCE_READER_PROFILE_ID =
  "eidolon.ai-organ.resource-contract-capsule.v1" as const

/**
 * Eidolon's adapter reader admits the exact Holarchy-owned snapshot contract.
 * Canonical snapshot and issuance-receipt parsing remains in Holarchy and is
 * applied by the domain projection after this synchronous Halfcode boundary.
 */
export const HOLON_EFFECTIVE_SNAPSHOT_EIDOLON_READER_REGISTRATION_V1:
KindReaderRegistration<PortableSpec> = Object.freeze({
  readerId: "holarchy-eidolon-adapter.holon-effective-snapshot.v1",
  subjectFqn: HOLON_EFFECTIVE_SNAPSHOT_KIND_SPEC_REVISION_V1.subjectFqn,
  readerSpecVersion: HOLON_EFFECTIVE_SNAPSHOT_KIND_SPEC_REVISION_V1.specVersion,
  contractFingerprint: HOLON_EFFECTIVE_SNAPSHOT_KIND_SPEC_REVISION_V1.contractFingerprint,
  readerImplementationFingerprint: digestCanonical(Object.freeze({
    authority: "holarchy-eidolon-adapter/holon-effective-snapshot-reader/v1",
    contractFingerprint: HOLON_EFFECTIVE_SNAPSHOT_KIND_SPEC_REVISION_V1.contractFingerprint,
    operation: "admit-portable-spec-before-holarchy-canonical-byte-projection",
  })),
  compatibilityPolicy: "exact",
  read: (spec: PortableSpec) => spec,
})

const EIDOLON_RESOURCE_OWNERS = Object.freeze([
  HOLON_EFFECTIVE_SNAPSHOT_KIND_OWNER,
  HOLON_EXECUTION_BINDING_KIND_OWNER,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER,
])

const EIDOLON_RESOURCE_REVISIONS = Object.freeze([
  HOLON_EFFECTIVE_SNAPSHOT_KIND_SPEC_REVISION_V1,
  HOLON_EXECUTION_BINDING_KIND_SPEC_REVISION_V1,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1,
])

const EIDOLON_RESOURCE_READERS: readonly KindReaderRegistration<any>[] = Object.freeze([
  HOLON_EFFECTIVE_SNAPSHOT_EIDOLON_READER_REGISTRATION_V1,
  HOLON_EXECUTION_BINDING_KIND_READER_REGISTRATION_V1,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_READER_REGISTRATION_V1,
])

/** Complete exact contract capsule for every resource Kind executable by Eidolon. */
export function createEidolonResourceResolutionContext(tree?: AuthoredResourceTree): AIWorkflowResourceResolutionContext {
  const base = createAIWorkflowResourceResolutionContext(undefined, tree)
  for (const owner of EIDOLON_RESOURCE_OWNERS) base.contracts.registerOwner(owner)
  for (const revision of EIDOLON_RESOURCE_REVISIONS) base.contracts.registerRevision(revision)
  for (const reader of EIDOLON_RESOURCE_READERS) base.readers.register(reader)
  const readerProfile = createReaderProfile(
    EIDOLON_RESOURCE_READER_PROFILE_ID,
    [...base.readerProfile.readers.values(), ...EIDOLON_RESOURCE_READERS].map((reader) => ({
      readerId: reader.readerId,
      subjectFqn: reader.subjectFqn,
      readerSpecVersion: reader.readerSpecVersion,
      contractFingerprint: reader.contractFingerprint,
      readerImplementationFingerprint: reader.readerImplementationFingerprint,
    })),
  )
  return Object.freeze({ ...base, readerProfile })
}
