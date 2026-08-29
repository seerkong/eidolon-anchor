# Design: closed provider binding and compatible live evidence

## Provider binding

The harness accepts only catalogued bindings:

| Binding | Provider id | Model | chat profile | evidence class |
| --- | --- | --- | --- | --- |
| `official-deepseek` | `deepseek` | `deepseek/deepseek-v4-flash` | `deepseek-official-chat@1` | `official` |
| `siliconflow-deepseek-flash` | `siliconflow` | `siliconflow/deepseek-ai/DeepSeek-V4-Flash` | `deepseek-compatible-chat@1` | `compatible` |
| `deepseek-iqingwa-v4-pro` | `deepseek-iqingwa` | `deepseek-iqingwa/deepseek-v4-pro` | `deepseek-compatible-chat@1` | `compatible` |

The binding is selected once by `run-codument-proposition-live.ts`, then passed to `runCodumentPropositionLiveCell`, live runtime admission and the shim via non-secret environment fields. The shim uses its model/profile in both ordinary and Workflow commands and records the selected identity. Provider credentials remain resolved by Eidolon's existing config and are never copied into the child environment.

## Evidence semantics

- `official` plans require every receipt scope to classify as `official_deepseek`.
- `compatible` plans require every receipt scope to classify as `deepseek_compatible`.
- Both require completed process, passing verifier, exact public mode identity, terminal-cause accounting, retained-prefix integrity and complete prefix counters.
- A transport observation with no usage is not silently promoted to a successful turn. It may remain visible as an `incomplete_usage` scope only when it is an unbilled pre-accept observation: the scope has no eligible subsequent turn, every token/cost/cache counter is zero and prefix integrity is preserved. Acceptance is fact-based rather than coupled to `providerRetries`, because transport replay, semantic continuation and cold epoch admission are separate lifecycles without a guaranteed 1:1 count.
- Compatible normalized cost may be unavailable because official DeepSeek weights are not transferable. Absence is reported, not synthesized.
- Cache coverage uses provider-reported hit/miss tokens and the same immediately-previous-prefix denominator, and every report names the exact compatible gateway rather than treating it as official evidence.

## DeepSeek semantic-completion adaptation

Switching to `deepseek-iqingwa/deepseek-v4-pro` intentionally changes both gateway and model behavior. The matrix preserves Pro thinking; it may not disable thinking, fall back to Flash, or install a global short-reasoning prompt.

The first AI Ctrl receipt exposed two consecutive provider responses with reasoning but no content/tool call, consuming 9,010 and 9,150 completion tokens. The model catalog declared an output limit of 300,000 tokens, but the Chat Completions request did not project that limit to `max_tokens`. Treating this shape as a retry-count problem is incorrect: a DeepSeek thinking turn is semantically complete only when it yields assistant content or tool calls, while `length`/resource termination or a gateway stream ending after reasoning is incomplete.

The corrected protocol is budget- and progress-governed:

1. the DeepSeek Chat profile projects the actor's explicit model output limit to the wire request as `max_tokens`;
2. the stream core preserves normalized terminal cause (`finish_reason` and compatible aliases) and distinguishes actionable completion from reasoning-only incomplete completion;
3. the first incomplete completion closes its real usage/cache evidence and appends one immutable `provider-recovery` fact at the current Conversation history anchor;
4. the existing `ContextPipeline` rematerializes `history-before-anchor ++ recovery fact ++ history-after-anchor` without changing `MessagePrefix`;
5. further incomplete completions reuse exactly that materialized request prefix rather than appending more instructions;
6. replay continues only while the outer operation is live and provider-reported completion-token usage makes positive progress inside the logical turn's cumulative output budget;
7. the next request receives the remaining output budget; missing usage, zero progress, exhausted budget, cancellation, content filtering or any unsafe/non-semantic failure fails closed;
8. explicit compaction starts a new provider epoch and drops the obsolete zero-proof recovery fact.

There is deliberately no reasoning-only retry-count threshold. The termination authority is the declared token/deadline budget plus observed progress. The mature runtime mapping remains:

| Existing authority | Original code evidence | Halfcode/resource-path role |
| --- | --- | --- |
| model/output configuration | `ModelConfigOps.ts`, actor model config | provides the admitted logical-turn output budget |
| DeepSeek wire projection | `ChatCompletionsEffectBundles.ts`, `OpenAICompletionsNodejsFetchAdapter.ts` | emits provider-standard `max_tokens` and preserves terminal/usage facts |
| semantic result validation | `ChatCompletionsStreamCore.ts` | distinguishes actionable output from incomplete reasoning-only output |
| provider attempt lifecycle | `ProviderErrors.ts`, `AiAgentExecutor.ts` | closes each attempt and applies budget/progress admission before replay |
| durable context anchoring | `ActorProviderContextFact.ts` | stores one recovery fact against history generation/message frontier |
| dynamic history splice | resource Agent `ContextPipeline` backed by the existing Conversation runtime | places the recovery fact at its declared anchor while leaving stable prefix immutable |
| provider epoch/compaction | existing Conversation/ProviderEpoch projection and compaction owner | preserves exact prefix inside an epoch and removes obsolete recovery only at an explicit successor epoch |

Deterministic verification must cover explicit output-budget projection, terminal-reason aliases, multiple reasoning-only completions without a count cutoff, positive-progress budgeting, no-progress fail-closed behavior, exact request-prefix reuse, attempt usage closure and compaction cleanup. Live Ctrl/Data receipts remain the product acceptance authority.

The next real Ctrl run then proved the continuation path rather than merely the happy path: four provider attempts were semantically replayed, including a reasoning-only attempt that consumed 8,122 completion tokens, and the Agent still completed and archived the generated Codument Track. Its first receipt was rejected at provider turn 10 because `max_tokens` changed from the admitted 300,000 budget to the remaining 291,878 budget. Unit comparison localized the only divergence to ordinal 0 `request_prefix`; all tool-schema and retained-message digests were exact. This was an observation-model defect, not a Conversation-prefix mutation.

The cache authority is therefore split explicitly:

- `requestDigest` continues to fingerprint the complete serialized HTTP body, including `max_tokens`, inference controls and transport flags;
- retained-prefix `units` describe the versioned DeepSeek chat-template/model framing plus exact tool/message material—the input from which provider prompt-cache eligibility is derived;
- completion-side controls may change during a semantic continuation without declaring an input-prefix miss;
- a tool or retained-message change inside the same provider epoch still fails the prefix gate byte-for-byte.

This is not an exception for one retry ordinal. It makes output-budget control and input-cache identity separate authorities for every DeepSeek official/compatible request.

The AI Data receipt exposed the same fixed-count assumption in the acceptance layer: three zero-usage cold/pre-accept scopes were visible while runtime timing reported two provider retries. Process output and the independent verifier passed, 154 provider calls had zero failures, and every retained prefix was exact. The acceptance rule now evaluates each incomplete scope by its own zero-billing and integrity facts; it no longer guesses validity from equality with a different lifecycle's retry counter. Any incomplete scope with prompt/output/cache/cost usage or prefix damage still fails closed.

## Live sequence

1. Run deterministic proposition/resource tests.
2. Build `dist/eidolon` and perform local install.
3. Bind one executable epoch containing the built Eidolon runtime closure and current Codument executable.
4. Execute `stream-pipeline-ai-agent` sequentially in ordinary, AI Ctrl and AI Data using one run id and the user-selected iQingwa binding.
5. Preserve per-cell workspace, raw logs, shim evidence and sealed receipt.
6. Produce a Chinese report from the receipts; if a cell fails, localize the gap and repair before rerunning only the affected cell(s).

## Cybernetic repair protocol

The first pass is an observation run and stops on the first failed cell. A completed failed receipt is valid evidence for closing P2: it must preserve the exact executable epoch, terminal cause, provider attempts and cache counters. P3 then repairs the smallest shared runtime or prompt invariant and starts a new immutable executable epoch for all three modes.

The SiliconFlow first pass failed in ordinary mode after one 941.5-second provider wait. Its tool surface was identical to the earlier successful official run (77 schemas / 24,595 tool-surface tokens), and its initial message surface differed by only five estimated tokens. Therefore the long reasoning stream is treated as a provider-path observation, not evidence that the mature Agent prompt needs a new generic control rule. The proposed prompt mitigation was withdrawn. The next immutable epoch uses `deepseek-iqingwa/deepseek-v4-pro` as explicitly directed by the user.
