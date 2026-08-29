# Mission Design: validate-codument-e2e-propositions-across-eidolon-modes

## Desired-state model

The controlled system is Eidolon's ability to carry an unchanged, real Codument engineering proposition to a verifier-accepted outcome. Execution mode is an independent variable, not permission to reinterpret the proposition.

```text
frozen proposition + verifier + tool/runtime policy
                         |
             +-----------+-----------+
             |           |           |
          ordinary     Ctrl        Data
             |           |           |
       isolated workspace and official DeepSeek receipts
             |           |           |
             +-----------+-----------+
                         |
        independent correctness + stability + cost observer
                         |
             gap -> repair Track -> selective rerun
```

Ordinary mode has no planning/coding/testing/releasing stage authority. Ctrl and Data lifecycle authority belongs to their dedicated Workflow runtime; their node agents solve the same engineering proposition without mutating the retained system-prefix according to inferred stages.

## Authority boundaries

- **Codument source repository:** authority for proposition text, fixtures, scoring and independent verifiers. It is read-only for this Mission.
- **Frozen corpus manifest:** authority for exactly which source bytes a run consumed. It includes file hashes because the source worktree can be dirty.
- **Eidolon harness:** authority for mode selection, isolated workspace creation, invocation, timeout, process/session recovery and evidence collection. It cannot decide whether generated work is correct.
- **Original independent verifiers:** authority for proposition correctness.
- **Provider receipts/final-wire observations:** authority for official DeepSeek token/cache facts and retained-prefix identity.
- **Mission reconciler:** authority for classifying gaps and scheduling repair Tracks; it cannot waive original acceptance criteria.

## Mode contract

| Mode | Required identity evidence | Forbidden behavior |
| --- | --- | --- |
| ordinary | normal primary/code actor execution and no Workflow instance | inferred Workflow stages, Workflow-only tools or hidden Workflow runtime |
| AI Ctrl Workflow | Ctrl Workflow instance, lifecycle events and Ctrl node execution | fallback to ordinary/Data or node-owned lifecycle authority |
| AI Data Workflow | Data Workflow instance, data-flow/lifecycle events and Data node execution | fallback to ordinary/Ctrl or node-owned lifecycle authority |

All modes share proposition bytes, project seed, environment policy, official DeepSeek profile, timeout class and verifier. Workflow envelopes may add stable workflow-specific context and tools, but cannot alter product requirements.

## Proposition layers

### Modeling and engineering

The Todo, Blog and Ecommerce core/payment journeys exercise Codument planning plus implementation. Acceptance includes exact BehaviorPatch XNL, domain/backend/surface Modeling deltas, at least three required Engineering knowledge categories, strict validation, completed Tracks, runnable applications and proposition-specific domain authority/state-machine/message semantics.

### Project implementation

The stream-pipeline journey exercises one long engineering session. Acceptance retains the source verifier's file contract, Python 3.10+ isolated install, actual RxPY Subject/Observable pipeline, lexical/syntactic/semantic/projection stages, real OpenAI-style agent/tool loop, tool-call delta handling, readline shell, compileall and pytest.

### Nested Mission

The B2C order/inventory journey exercises two repositories and hierarchical control planes. Acceptance retains reciprocal parent/child Mission links, exact selected-task subset, cross-layer Track references with project/mission/track identity, portable ignored workspace bindings, real service code/tests and strict validation in both repositories.

## Measurement contract

Every run produces a structured receipt with corpus manifest digest, journey/mode, Eidolon and Codument provenance, official provider/model identity, completion/verifier status, session/Workflow identity, retries/errors, token facts, retained-prefix digest/length, explicit epoch reasons, normalized charged input, elapsed time and redacted artifact paths.

The canonical cache ratio is `cache_hit_input_tokens / (cache_hit_input_tokens + cache_miss_input_tokens)`. Reports separate cold/short-context turns, forward-only turns within one stable context epoch, and explicit epoch transitions such as model/provider switch, rewind, compaction or accepted resource revision.

G1 ratifies the exact minimum denominator and target before runs. Historical live evidence of approximately `99.5%` on long Codument Missions is the regression baseline. Prefix integrity must be `1.0` within an epoch regardless of provider aggregate reporting.

Cost comparison is conditional on verifier-equivalent completion. It reports raw tokens and provider-native cached/uncached charging where available; otherwise it uses a clearly labelled normalized charged-input proxy rather than inventing currency cost.

## Harness strategy

The G2 Track should reuse existing provider-cache product-E2E instrumentation and add proposition adapters rather than introducing a second request observer. Its boundary is:

- immutable scenario manifest in;
- fresh temporary workspace and explicit mode adapter;
- bounded Eidolon process with machine-readable receipts;
- original verifier invocation after the agent session;
- retained raw log plus redacted structured summary out.

The harness supports individual scenario/mode reruns, sentinel subsets and full matrices. Live runs are explicit because they consume provider quota, while deterministic tests validate orchestration and receipt calculations in normal CI.

## Control loop and replanning

After each TaskGroup, the observer records evidence and the reconciler classifies deviations as proposition/output, mode-boundary, provider-projection, session, cost or harness gaps. A harness gap permits no product conclusion.

For a real product gap the planner creates one minimal Track with RED evidence, expected behavior deltas and focused plus sentinel verification. After implementation, only affected journeys and at least one unaffected sentinel run first; a full matrix follows once repairs converge. Repeated failure of the same cause triggers replan rather than threshold relaxation.

## Track boundaries

Initial candidate Track:

- `add-codument-proposition-trimodal-e2e-harness`: reusable scenario manifests, explicit ordinary/Ctrl/Data launch adapters, isolated workspace lifecycle, receipt schema, verifier runner and deterministic orchestration tests.

Potential repair Tracks are deliberately unnamed until evidence exists. A Track may not combine unrelated failures merely because they appeared in the same matrix.

## Verification layers

1. Harness unit/contract tests for mode identity, isolation, timeout, redaction and metric math.
2. Existing Eidolon focused/full tests and strict Codument validation after every repair.
3. Original proposition verifier and score scripts inside each generated workspace.
4. Provider receipt/prefix analysis over official DeepSeek live runs.
5. Fresh independent Mission verification over the final matrix and evidence provenance.

The Mission is complete only when all selected propositions pass in all modes, measurement evidence is comparable, and the independent verdict contains no P0/P1 gap.

## Reopened architecture: legacy-to-Halfcode Agent refactor

The reopened phase treats the existing Eidolon Agent chain as the behavioral baseline. `AIAgentDefinition` must not introduce a parallel message, conversation, session, provider or recovery runtime. Halfcode resources declare and freeze the Agent definition and its code/prompt dependencies; Eidolon continues to host the established runtime authorities.

```text
Halfcode ResourcePackage
  ├─ AIAgentDefinition
  ├─ MessagePrefix
  │    ├─ Prompt/resource message producers
  │    ├─ Workspace AGENTS.md message producer
  │    └─ optional code-backed 0..N message producers
  └─ ContextPipeline
       └─ resource-managed dynamic code
                    |
                    v
          Eidolon Message Compiler
                    |
                    v
      existing Actor + Conversation Domain
      existing tool/provider/session/cache runtime
```

### Mandatory legacy-to-Halfcode migration ledger

The core AIAgentDefinition Track `design.md` must contain an exhaustive table with these columns:

| Legacy capability | Existing behavior/invariants | Original code evidence | Current authority owner | Halfcode mapping | New resource/code evidence | Compatibility/cutover | Parity verification | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

`Disposition` is closed to `preserved`, `relocated`, `adapted`, `deferred` or `removed`. A deferred row must reference another bound Mission Track. A removed row requires an explicit decision and replacement behavior. The Track cannot complete while any discovered legacy capability is unmapped.

The initial inventory is a routing seed, not an exhaustive substitute for the Track scan:

| Legacy area | Approximate code location | Required mapping direction |
| --- | --- | --- |
| Runtime profile ordering | `cell/packages/mod-profiles/src/index.ts` | Resource Agent composition order and compatibility adapter |
| Kernel work loop/rules | `cell/packages/mod-ai-kernel/src/prompt/` | copied versioned Prompt resources referenced by `MessagePrefix` |
| Primary Agent/Identity/Routing/coding rules | `cell/packages/mod-ai-coding/src/agent/`, `src/prompt/` | copied Prompt resources and ordered message producers |
| Workspace `AGENTS.md` | `cell/packages/mod-ai-coding/src/prompt/index.ts` | `MessagePrefix` child processor with equivalent workspace semantics and frozen digest |
| Resource Agent projection | `cell/packages/ai-organ-logic/src/resources/EidolonAppResourceRegistryAdapter.ts` | typed projection/freeze of `MessagePrefix` and `ContextPipeline` code dependencies |
| Child Actor creation | `cell/packages/ai-organ-logic/src/agent/DelegateActor.ts` | reuse existing Actor admission and Conversation seeding |
| System/platform message materialization | `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts` | explicit compiler contribution without hidden duplicate prompts |
| Conversation prompt projection | `cell/packages/ai-support/src/conversation/local/LocalConversationRuntime.ts` | code-backed `ContextPipeline` over canonical Conversation facts |
| Context fact anchors | `cell/packages/ai-organ-logic/src/conversation/ActorProviderContextFact.ts` and LocalConversationRuntime | preserve durable history-generation/message-count/frontier anchors |
| Work-context control | `cell/packages/ai-organ-logic/src/runtime/ContextControlPlane.ts` | explicitly selected pipeline behavior; ordinary Agents receive no implicit Workflow lifecycle |
| Provider epoch handoff | `cell/packages/ai-organ-logic/src/conversation/ProviderEpochProjection.ts` | copied pipeline code with exact epoch and bounded-history semantics |
| Backward safe compaction split | `cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts` | copied pipeline code preserving user/tool boundaries and protected pending history |
| Compaction/context persistence | `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`, Conversation Domain runtime | resource code proposes projections/transitions; existing owner validates and commits |
| Tool surface/admission | resource registry and `WorkflowNodeActorAdmission.ts` | exact `ToolRefs` plus existing authorization/runtime isolation |
| Provider request conversion | `AiAgentExecutor.ts` and provider adapters | remain existing adapter authority; consume compiled canonical messages |
| Stable-prefix/cache evidence | `ContextControlPlane.ts`, provider-context/cache observation modules | hash compiled resource prefix/tools and preserve explicit context epochs |

### MessagePrefix contract direction

`MessagePrefix` replaces the ambiguous authored `Messages` seed-list meaning. Its heterogeneous ordered children compile through their registered node processors to zero, one or many provider-neutral messages. Prompt-backed nodes, workspace instruction nodes and code-backed nodes all participate in one ordered program. Static resource messages and workspace instructions are frozen with identities/digests before Actor execution.

### ContextPipeline contract direction

The first `ContextPipeline` is deliberately code-backed rather than over-declared. It receives canonical Conversation/history facts, admitted context facts and runtime/provider budget inputs, and produces the complete dynamic context segment plus evidence/proposals required by existing owners. It does not receive mutable access to the compiled prefix.

Its copied implementation must preserve both distinct history-boundary behaviors:

1. durable context facts split history at their admitted `historyGenerationId + messageCount + frontierDigest` anchor and splice the fact between the two retained halves;
2. compaction scans backward for a safe user or complete tool-call boundary, protects pending history, summarizes the old half and places the snapshot/acknowledgement before the retained recent half.

The final canonical construction is `compiled MessagePrefix ++ compiled ContextPipeline segment`. Provider adapters may encode that canonical list for their wire protocol but may not invent Agent semantics or silently reorder the stable prefix.

### Migration and proof strategy

The Workflow resource Agent is the trial surface. During the trial, copied resources are versioned candidate authorities for Workflow nodes while the ordinary coding profile remains the production baseline. Every copied file records provenance and content identity. Behavioral snapshots, long-session compaction/recovery, provider switching, exact tool surfaces and cache-prefix evidence compare both paths.

After parity is independently proven, a later explicit cutover may make resource `AIAgentDefinition` the authority for ordinary Eidolon Agents and reduce the old profile loader to a compatibility adapter. That later cutover is not silently implied by this Mission.

### Cross-project projection/freeze prerequisite

Execution-time observation found that the closed `AIAgentDefinitionProjection`, dependency edges, authentic projection brand and `freezeAIWorkflowRunResources` semantic fingerprint are owned by the bound `depa-flows` project (`packages/ai-workflow-contract` and `packages/ai-workflow-logic`). Eidolon cannot safely add `MessagePrefix` or `ContextPipeline` by parsing around that boundary: doing so would make the runtime plan diverge from the authentic frozen resource closure.

G9 therefore has two ordered Track operations:

1. `depa-flows`: add the heterogeneous `MessagePrefix` projection and code-backed `ContextPipeline` reference to the closed resource contract, dependency graph and semantic freeze fingerprint.
2. `eidolon-anchor`: bind the projected/frozen resources to the existing mature Agent runtime and perform the full legacy-parity migration.

The second Track must consume the first Track's released/local-installed package bytes; it may not reimplement or bypass the projection/freeze authority.
