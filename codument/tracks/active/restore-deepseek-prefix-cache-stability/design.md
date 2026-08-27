# Design: restore-deepseek-prefix-cache-stability

## 1. Authority boundaries

Canonical Conversation/ToolCall facts remain the only semantic history. Prefix-cache diagnostics are derived provider observations. `ActorToolPolicy.allowedTools` remains the execution authorization truth; a stable provider schema projection is only a presentation surface and cannot authorize a call.

DeepSeek's provider-managed cache is external authority. Eidolon may observe reported hit/miss tokens and prove local request-prefix stability, but MUST NOT manufacture a cache hit receipt.

## 2. Stage context as an append-only fact

`WorkflowLoadStageContext(runtime, input, config)` continues to load the exact global stage resource and update Workflow progress/tool authorization. It stops adding or replacing the `eidolon:sys-eidolon-anchor-devops-stage` marker in `actor.systemPrompts`.

Instead, the trusted tool result contains a closed stage-context envelope: kind, stage, authority, exact allowed tools and the loaded context. The normal single-writer tool-call pipeline appends this result after the preceding request. A later stage selection therefore extends the prior provider prefix; it does not rewrite the root.

If a recovered actor still contains the legacy dynamic stage marker, the first new stage load removes it and calls the existing continuation-baseline reset with reason `legacy_stage_prompt_migration`. The incremented baseline epoch is the observable local cache-epoch boundary; it is not a fabricated provider cache receipt and does not advance ProviderEpoch when provider/profile is unchanged. The migration request is explicitly excluded from ordinary prefix-stability claims; subsequent stage transitions are append-only.

The latest stage result is authoritative for current stage guidance. Earlier stage results are historical transition facts, not competing current projections.

## 3. Stable schema surface versus execution policy

`ActorToolPolicy` carries an optional closed provider surface `{ mode: "all" | "exact", toolNames: string[] }`. On actor creation it snapshots the configured authorization mode and names before any dynamic narrowing. Workflow stage selection mutates only `allowedTools`; it does not mutate that provider surface.

For `cachePolicy.stablePrefix=true`, `mode=all` projects the complete built tool registry and `mode=exact` projects the named subset; both subtract `computedDisabledTools` and use explicit code-unit ordering. For other models the existing dynamic allowed subset remains. Every actual tool execution still calls `isToolAllowed` against the current exact stage policy, so provider visibility cannot grant authority.

For Workflow actors, the canonical stable surface is the code-defined union of every `AI_WORKFLOW_STAGE_TOOL_POLICY` member. Old snapshots without a surface are rebuilt from that union, never from the currently narrowed stage. Installing or correcting this legacy surface calls the continuation-baseline reset with reason `workflow_tool_surface_migration`, producing one explicit new local cache epoch. Generic legacy actors without a profile-derived surface retain their current mode/names and are marked as a migration epoch rather than being claimed prefix-stable.

## 4. Cache usage observation

DeepSeek Chat requests default `stream_options.include_usage=true` unless the user explicitly supplies `stream_options`. The Chat transport observes usage-only SSE chunks, accepts only finite non-negative numeric usage fields, and resolves them through `LlmStreamResult.providerOutput` after the stream completes.

After the final successful attempt, the executor maps `prompt_cache_hit_tokens` to existing `usage.cache_read_tokens`. For compatibility, `prompt_cache_miss_tokens` maps to existing `usage.cache_creation_tokens`, whose meaning for DeepSeek is explicitly “provider-reported miss/cache-fill input”, not proof that the provider retained a new entry. Hit rate is derived from these two exact counters. Existing prompt/completion/total counters keep their current estimate semantics, so actual usage is not double-counted against an estimate.

The usage carrier is provider output, not an assistant-message property, and MUST NOT enter Conversation history or provider replay. Retries expose only the final successful attempt's output; malformed/negative usage is ignored, failure records no cache facts, and compatible endpoints that omit usage continue to use existing estimates. Explicit `include_usage=false` is preserved.

## 5. Cache epoch boundaries

The prefix-stability invariant applies to ordinary same-provider/model, uncompacted, forward-only turns. Provider/profile/model switch, compaction, rewind and explicit context reset begin a new cache epoch. Pending provider/tool deliveries remain protected by the existing provider-epoch and conversation-spine contracts.

The ProviderEpoch receipt addresses only the canonical source handoff admitted at provider/profile activation. Its source message count, initial pending-delivery ids and content digests remain frozen while ordinary target-provider turns append after that handoff. Before transport, Eidolon revalidates those frozen facts against the current canonical prefix; it does not enlarge the handoff to include the newly appended target-provider tail. A compaction/rewind/source replacement may rebuild the projection addresses, and is already an explicit cache boundary.

## 6. Verification

Focused tests compare complete projected `messages` and `tools` across coding -> testing Workflow turns and require the earlier request to be an exact prefix of the next. Separate tests prove a disallowed stage tool remains blocked even while its schema stays visible. Stream tests use DeepSeek-compatible usage-only terminal chunks and assert cache counters without persisting usage into assistant history.
