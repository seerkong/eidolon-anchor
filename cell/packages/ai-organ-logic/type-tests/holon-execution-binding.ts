// Compile-only strict gate. Imports intentionally include the real production
// registry/freeze owner and the exact published Holarchy snapshot authority.
import {
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE,
  normalizeHolonExecutionBinding,
  type HolonExecutionBinding,
} from "@cell/ai-organ-contract/organization/HolonExecutionBinding"
import {
  assertHolonExecutionBindingFreezeReceipt,
  type EidolonHolonExecutionBindingFreezeReceipt,
  type EidolonHolonExecutionBindingProjection,
} from "../src/resources/HolonExecutionBindingProjection"
import {
  HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE,
  parseHolonEffectiveSnapshotBytes,
  parseHolonEffectiveSnapshotIssuanceReceiptBytes,
} from "holarchy-core-contract"
import {
  loadHolonDeploymentDefinition,
  materializeHolonDeploymentDefinition,
} from "../src/organization/HolonDeploymentDefinition"
import { FileHolonDeploymentRuntimeStore } from "../src/organization/HolonDeploymentRuntimeStore"
import { EidolonHolonLocalActorRuntime } from "../src/organization/HolonLocalActorRuntime"
import { executeHolonWorkflowTask } from "../src/organization/HolonWorkflowTaskRuntime"

const binding: HolonExecutionBinding = normalizeHolonExecutionBinding({
  apiVersion: "eidolon.ai/v1",
  kind: "HolonExecutionBinding",
  bindingRef: "resource://typed.binding",
  snapshotRef: "resource://typed.snapshot",
  target: { kind: "member", memberRef: "member-1" },
  adapter: {
    kind: "service",
    serviceAdapterRef: "resource://typed.service",
    runtimeProfileRef: "resource://typed.runtime",
  },
  policy: {
    version: "1",
    runtime: { mode: "shared-member-runtime" },
    taskProfileRef: "resource://typed.task-profile",
    capabilityRefs: [],
    toolRefs: [],
    materialRefs: [],
  },
})
void binding

const verifyFreeze = (
  value: EidolonHolonExecutionBindingFreezeReceipt,
): EidolonHolonExecutionBindingFreezeReceipt => assertHolonExecutionBindingFreezeReceipt(value)
void verifyFreeze
declare const projection: EidolonHolonExecutionBindingProjection
void projection
void parseHolonEffectiveSnapshotBytes
void parseHolonEffectiveSnapshotIssuanceReceiptBytes
void HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE
void HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE
void loadHolonDeploymentDefinition
void materializeHolonDeploymentDefinition

// The local deployment owner, generic actor adapter and product TaskSpace
// Processor—not only the contract/projector—remain in this strict program.
void FileHolonDeploymentRuntimeStore
void EidolonHolonLocalActorRuntime
void executeHolonWorkflowTask
