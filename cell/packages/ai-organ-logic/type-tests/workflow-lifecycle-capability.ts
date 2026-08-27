import type {
  ActorRuntimeFacetCodecEntry,
  ActorRuntimeFacetEvent,
} from "@cell/ai-core-contract/runtime/ActorRuntimeFacet"
import type { ActorDurableMaterial } from "@cell/ai-core-contract/runtime/ActorDurableMaterial"
import { estimateFinalWireProviderCacheCostTokens } from "../src/llm/ProviderCacheCostEstimates"
import { WORKFLOW_LIFECYCLE_FACET_CODEC } from "../src/workflow/runtime/WorkflowLifecycleFacet"
import { AI_WORKFLOW_PROVIDER_TOOL_SURFACE } from "../src/workflow/tools/WorkflowStageToolCatalog"

declare const codec: ActorRuntimeFacetCodecEntry
declare const event: ActorRuntimeFacetEvent
declare const material: ActorDurableMaterial

void codec
void event
void material
void estimateFinalWireProviderCacheCostTokens
void WORKFLOW_LIFECYCLE_FACET_CODEC
void AI_WORKFLOW_PROVIDER_TOOL_SURFACE
