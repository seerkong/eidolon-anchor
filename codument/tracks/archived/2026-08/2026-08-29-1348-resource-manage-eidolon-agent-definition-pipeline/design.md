# Design: complete Agent pipeline as Halfcode resources

## Invariants

1. `MessagePrefix` and `ContextPipeline` are siblings on `AIAgentDefinition`; neither is an ambient Workflow-stage prompt.
2. Every `MessagePrefix` child compiles to `0..N` messages. Static `Message` is the one-message case; `MessageSource` is the dynamic splice case.
3. A frozen resource dependency, not a mutable path, identifies every prefix source and context pipeline.
4. The stable prefix is completed before the active history tail. Context facts use their durable history anchors; WorkContext and late overlays splice only at the declared conversation boundary.
5. Conversation Domain owns history/prompt/context state and durable transitions. `ContextPipeline` selects and observes the canonical derivation; it does not commit a parallel history.
6. Legacy `<Messages>` remains accepted during the staged cutover and maps to the same static-prefix compatibility view.

## Legacy-to-Halfcode migration ledger

Disposition is closed to `preserved`, `relocated`, `adapted`, `deferred`, or `removed`.

| Legacy capability | Existing behavior / invariant | Original code evidence | Authority owner | Halfcode mapping | New resource / code evidence | Compatibility / cutover | Parity verification | Disposition |
|---|---|---|---|---|---|---|---|---|
| Profile extension order | platform → AI kernel → coding; later sections append and do not replace the prefix | `cell/packages/mod-profiles/src/index.ts`; `mod-ai-kernel/src/index.ts::applyModAiKernel`; `mod-ai-coding/src/index.ts::applyModAiCoding` | runtime profile composer | ordered `MessagePrefix` items | mature CodeAgent resource fixture and prefix compiler | ordinary actors keep profile composer; Workflow CodeAgent uses copied resources | exact ordered prefix snapshot | adapted |
| Kernel work loop and rules | kernel work loop precedes kernel rules and renders delegate descriptions | `cell/packages/mod-ai-kernel/src/prompt/index.ts::buildModAiKernelPromptSection`; `KernelWorkLoop.md`; `KernelRules.md` | kernel prompt assets | static Prompt-backed Message item | copied kernel Prompt content in CodeAgent package | source prompt remains for legacy profile | content sentinel and order tests | relocated |
| Coding identity/routing/rules | primary Agent, identity, routing and prompt modules compose a mature coding instruction section | `cell/packages/mod-ai-coding/src/agent/AgentDefinitionLoader.ts::buildAgentPromptSections`; `buildBundledPrimaryPromptSection` | coding prompt assets | static Prompt-backed Message item | copied primary/coding Prompt content in CodeAgent package | built-in actors keep existing assets until later migration | mature instruction sentinels in resource plan | relocated |
| Delegate guidance | available Agent descriptions are part of the stable instruction prefix | `AgentDefinitionLoader.ts::buildBundledDelegateGuidanceSection`; `mod-ai-coding/src/index.ts` | coding profile composer | static Prompt-backed Message item | copied Workflow delegate guidance Prompt | legacy builder remains authoritative for non-resource Agents | guidance sentinel and ordering | adapted |
| Workspace instructions | read `<workDir>/AGENTS.md`; missing/empty/error produces no section | `mod-ai-coding/src/prompt/index.ts::loadWorkspaceAgentsPromptSection` | workspace filesystem + coding profile | `MessageSource` splices `0..1` system messages using bound workspace root | `AgentMessageSource` code resource + `compileAgentMessagePrefix` | legacy loader remains for profile Agents; resource path is behavior-equivalent | present/missing/empty and content tests | relocated |
| Resource projection/freeze | Agent dependencies are typed, immutable, closure-frozen and semantic fingerprinted | `depa-flows.ts/packages/ai-workflow-logic/src/agent-resources.ts`; `run-freeze.ts` | depa-flows resource projection | `MessagePrefix` union + `ContextPipeline` refs | external Track `extend-ai-agent-definition-halfcode-composition` | legacy `<Messages>` compatibility projection retained | external 23 focused / 194 full tests | preserved |
| Resource plan materialization | exact prompt/tool/material identities compile to one immutable `AgentConfig` | `EidolonAppResourceRegistryAdapter.ts::materializeAgentExecutionPlanFromSnapshot` | Eidolon resource adapter | prefix compiler plus validated context-pipeline binding | `AgentMessageComposition.ts`; updated execution plan | legacy static messages compile through same path | adapter tests and fail-closed diagnostics | adapted |
| Child Actor construction | exact config, tools, seed messages, work context and execution contract create one Delegate Actor | `DelegateActor.ts::spawnChildExecutionActor` | Agent runtime | compiled `AgentConfig` feeds unchanged actor creation; pipeline binding is copied onto actor | `AgentConfig` / actor binding extension | no new Workflow actor implementation | delegate creation and seed parity tests | preserved |
| Conversation seeding | seed messages enter semantic Conversation domains; raw arrays are compatibility mirrors | `AiAgentExecutor.ts::seedConversationDomainFromActorSeedMessages`; `DelegateActor.ts` call site | Conversation Domain | compiled prefix seed uses same seeding function | unchanged call path | no direct provider-message bypass | conversation seed assertion | preserved |
| Prompt plan snapshot | actor system prefix is recorded on prompt generation; message arrays are not the authority | `ContextControlPlane.ts::buildPromptPlanForActorExecution`, `recordPromptPlanForActorExecution`; `AiAgentExecutor.ts::buildProviderPromptForActorTurn` | LLM Context Domain | standard pipeline declares `prompt-plan` stage and invokes canonical implementation | `StandardContextPipeline.ts` descriptor/binding | actors without binding use the same standard default during cutover | prompt-generation prefix snapshot test | adapted |
| Compaction prelude | summary/ack and context assets appear before active tail | `LocalConversationRuntime.ts::materializePromptTransformPrelude` | Conversation Domain projection | `conversation-prelude` stage | standard ContextPipeline resource code stage list | no state copied into resource | compacted-session materialization test | preserved |
| Backward dynamic history insertion | context facts are grouped by durable `historyMessageCount` anchors and inserted while walking history | `LocalConversationRuntime.ts::currentActorProviderContextFacts`, `insertProviderContextFactsAtHistoryAnchors`, `materializeConversationRuntimePrompt` | Conversation Domain + Context Fact runtime | `provider-context-facts-at-history-anchors` stage | standard pipeline code declares exact stage and canonical executor | resource cannot relocate anchors | multi-anchor ordering test | preserved |
| Stable prefix materialization | prompt-generation system prompts are prepended once, in stable order | `LocalConversationRuntime.ts::readPromptGenerationSystemPrompts`, `materializeSystemPromptStage` | LLM Context Domain projection | `stable-message-prefix` stage | standard pipeline code + compiled MessagePrefix | legacy actor system prompts remain supported | exact prefix integrity test | adapted |
| WorkContext and late overlays | dynamic overlay inserts after leading system block and before non-system history; late overlays use same boundary | `ContextControlPlane.ts::insertDynamicOverlayAtConversationBoundary`, `buildWorkContextOverlayText`; `LocalConversationRuntime.ts::insertDynamicOverlaysAtConversationBoundary` | ContextControlPlane / Conversation projection | `conversation-boundary-overlays` stage | standard pipeline code declares splice point | never mutates the stable prefix | boundary ordering test | preserved |
| Provider epoch / handoff | provider/profile change records and validates epoch receipt/frontiers, resets continuation baseline | `conversation/ProviderEpoch.ts::activateActorProviderEpoch`, `validateActorProviderContextEpoch`, `reconcileActorProviderEpochProjection` | Provider Epoch + Conversation Domain | `provider-epoch-admission` stage reference; no transition code in resource | standard pipeline source documents owner call | exact existing owner remains | epoch/handoff and resumed-session tests | preserved |
| History compaction split | scan from the tail, keep recent complete turns and protect tool/message deliveries | `compression/ContextCompressor.ts::findSplitPoint`, `findProtectedSplitPoint`, `applyCheapCompactionPipeline` | compaction runtime + Conversation Domain commit | `history-compaction-boundary` stage reference | standard pipeline source documents existing owner | compaction remains pre-provider control action | split/protected delivery tests | preserved |
| Durable recovery | actor bindings, generations, facts and epoch receipts reload before provider materialization | `persistence/RuntimeSnapshots.ts`; `LocalConversationRuntime.ts::loadConversationHistoryMessages`; `ProviderEpoch.ts` | persistence + Conversation Domain | pipeline identity/digest travels in Agent config/origin evidence; state continues to reload from existing stores | immutable pipeline binding on resource plan/actor | old snapshots without binding select standard default | recovery parity test | adapted |
| Exact tool admission | declared-only/none policies, exact Tool refs and provider tool surface are enforced | `EidolonAppResourceRegistryAdapter.ts`; `DelegateActor.ts::validateExactAgentTools`; `AiAgentExecutor.ts::resolveProviderToolsetForActor` | resource adapter + Agent executor | unchanged `ToolRefs` and `EffectPolicy` siblings | execution plan retains exact tool IDs | no tools are inferred from prefix/pipeline | exact schema/tool-count test | preserved |
| Provider conversion | canonical execution messages convert only at the adapter boundary | `AiAgentExecutor.ts::prepareMessagesForLlmAdapter`, `buildProviderPromptForActorTurn` | provider adapter boundary | terminal `provider-conversion` stage | standard pipeline invokes existing conversion port | no provider-specific resource Agent fork | adapter conversion test | preserved |
| Cache prefix / epoch evidence | stable prompt/tool schema yields comparable prefix; epoch changes are explicit | `ContextControlPlane.ts::buildPromptPlanCacheProfile`; `ProviderCacheObservationProjection.ts`; `ProviderEpoch.ts` | prompt plan + provider observation | resource content digests and pipeline digest become stable execution evidence | plan exposes prefix/pipeline digests | legacy Agents retain existing cache profile | stable digest and forward-only epoch tests | adapted |
| Workflow admission and identity | Workflow node freezes the exact resource Agent and does not silently select another mode | `WorkflowNodeActorAdmission.ts`; `EidolonWorkflowEffectProvider.ts`; `WorkflowRuntimeService.ts` | Workflow runtime + resource freeze | same receipt includes MessageSource and ContextPipeline closure | external freeze dependency edges + host prepared plan | no fallback to ordinary Agent | Ctrl/Data identity/effect tests | preserved |
| Ambient Workflow stage prompt | previously inferred planning/coding/testing labels could change the front prefix | `WorkflowLifecycleActorCapsule.ts`; cache-isolation Mission G1-G7 evidence | Workflow lifecycle | no MessagePrefix mapping | absent by design | Workflow lifecycle remains state/evidence only | prefix unchanged across Workflow progress test | removed |
| Arbitrary resource code execution | no trusted general evaluator exists today | current adapter only projects typed resources | security/runtime admission | first pipeline uses a closed implementation id plus frozen source bytes | fail-closed `StandardContextPipeline` loader | general sandboxed code modules require a later approved Track | unknown implementation rejection | deferred |

## First resource forms

`MessagePrefix` is ordered and heterogeneous:

```xnl
<MessagePrefix [
  <Message #kernel { role = "system" promptKind = "Prompt" promptRef = "resource://...Kernel" }>
  <Message #coding { role = "system" promptKind = "Prompt" promptRef = "resource://...Coding" }>
  <MessageSource #workspace { role = "system" sourceKind = "AgentMessageSource" sourceRef = "resource://...WorkspaceAgents" }>
]>
<ContextPipeline { pipelineKind = "AgentContextPipeline" pipelineRef = "resource://...StandardContext" }>
```

The message-source resource contains a closed code descriptor for `eidolon.workspace-agents/v1`. The adapter binds it to the workspace root and emits no message for missing/empty/unreadable `AGENTS.md`.

The context-pipeline resource contains source bytes with the closed implementation id `eidolon.standard-context-pipeline/v1` and the ordered stage ledger. The runtime validates its identity and digest, stores the binding on the Actor, and executes the canonical functions listed above. This is Halfcode's code-reference seam: resource bytes are evolvable and frozen, while privileged effects remain injected, typed runtime authorities. A later Track may add sandboxed arbitrary modules without changing `AIAgentDefinition`.

## Cache contract

- Prefix item ordering and resource content digests are stable within a freeze receipt.
- Workspace `AGENTS.md` is compiled once per prepared execution and becomes a seed system message; it does not move on every Workflow step.
- Context facts, WorkContext and late overlays splice after the stable leading system block or at their durable history anchors.
- Workflow progress does not replace any prefix item and therefore cannot create a stage-driven cache epoch.

## Verification

- Resource adapter unit tests: legacy compatibility, heterogeneous splicing, workspace source, pipeline diagnostics/digests.
- Conversation parity tests: multiple history anchors, stable prefix, boundary overlays, compaction/protected delivery and provider epoch.
- Workflow tests: both Ctrl and Data use the resource Agent, exact tools and same canonical materialization.
- Source ledger test: every ledger code path and resource mapping remains named, preventing silent omission in later changes.
