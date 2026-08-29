# Mission Proposal: validate-codument-e2e-propositions-across-eidolon-modes

## Goal

Use Codument's real E2E propositions as an external product workload to prove that the Eidolon tree committed at `34706c1` can complete long-running engineering work with the official DeepSeek provider in three execution modes:

1. ordinary Eidolon, with no AI Workflow lifecycle concepts;
2. AI Ctrl Workflow;
3. AI Data Workflow.

When evidence exposes a defect, the Mission must localize the gap, create the smallest justified repair Track, independently verify it and repeat the affected journeys until the desired state is reached.

## Why a Mission

This is a long-running feedback-control problem involving live provider behavior, multiple workflow runtimes, isolated generated projects, cross-repository propositions, cost/cache observations and evidence-driven replanning. A Track cannot honestly predeclare every repair before the first observations exist.

## Source proposition corpus

The Mission reads but does not modify `/Users/kongweixian/ai/ai-codument/codument`. The initial corpus includes:

- `e2e/modeling-engineering`: Todo, Blog, Ecommerce core and Ecommerce payment planning/implementation/score propositions;
- `e2e/project-implementation/stream-pipeline-ai-agent`: one-session Python/RxPY/OpenAI agent implementation and independent verifier;
- `e2e/nested-mission-agent`: two-repository B2C order/inventory implementation with root/child Missions and exact cross-project linkage;
- `e2e/nested-mission`: structural parent/child Mission portability checks used as a sentinel.

Because that source worktree may be dirty, G1 records content digests of every consumed request, fixture and verifier. A Git SHA alone is insufficient provenance.

## Required invariants

- All three modes receive the same proposition bytes and are judged by the same independent verifier.
- Runs use fresh isolated Git workspaces and record exact Eidolon, Codument CLI and source-corpus provenance.
- The configured model is the official DeepSeek model; compatible third-party providers are not substitutes.
- Ordinary execution contains no Workflow stage/lifecycle semantics.
- Ctrl and Data runs prove the requested Workflow kind actually executed and cannot silently fall back to ordinary mode.
- Correctness and completion are primary. Cache coverage and cost are measured only between outcome-equivalent runs.
- Cache reports distinguish warm-up/short-context turns from comparable long-context, forward-only retained-prefix turns.
- Credentials and raw secrets never enter Mission artifacts.
- Any product-code or test-harness change is implemented through a real Codument Track, not directly by a Mission task.

## Success criteria

- The selected Codument propositions pass their original strict validators, score/verifier scripts and application tests in all three modes.
- No accepted journey contains an invalid provider request, unrecoverable continuation failure, unexplained retry loop or mode-identity mismatch.
- Final-wire prefix observations explain every epoch transition and prove byte-stable retained prefixes within an epoch.
- Comparable official DeepSeek long-context runs meet the budget ratified in G1, using the historical approximately `99.5%` long-running Mission cache hit rate as a baseline rather than an assumption.
- Reports expose total input, cache-hit, cache-miss and output tokens, normalized charged-input cost, retries, elapsed time and completion quality by journey and mode.
- A fresh independent verifier reports no remaining P0/P1 correctness, lifecycle-isolation, stability, cache or cost gap.

## Non-goals

- Changing Codument's source propositions to make Eidolon pass.
- Treating deterministic provider mocks as live-provider acceptance evidence.
- Requiring identical prose, file layout beyond the proposition contract, or identical token counts across modes.
- Hiding workflow overhead behind aggregate percentages or accepting a high cache rate for an incorrect/incomplete result.
- Modifying or committing the external Codument source repository.

## Initial delivery shape

The only predeclared implementation Track adds the reusable tri-modal proposition harness. Subsequent repair Tracks are created only after live or independent-verifier evidence identifies an actual gap. Mission analysis and reports retain the frozen corpus manifest, run receipts, comparison tables, gap decisions and final verdict.

## Reopened scope — resource-native Agent parity

After the original matrix completed, follow-up inspection established that the Workflow proposition Agent is only a thin fixture and that proposition-only E2E modules leak through production package `src` and public indexes. The Mission is reopened to repair those boundaries and to trial a complete Halfcode-resource representation of the mature Eidolon Agent definition and message-processing chain.

This phase is a refactor of the existing implementation, not a greenfield or reduced Agent runtime. It must preserve the old code's behavior and reuse the existing Actor, Conversation Domain, history/recovery, tool, provider and cache authorities. The resource architecture takes ownership of Agent definitions, ordered message-prefix construction, code/resource dependencies, content identities and the selected context-pipeline implementation.

The agreed resource vocabulary is `MessagePrefix + ContextPipeline`. `MessagePrefix` is an ordered heterogeneous message-producing program. `ContextPipeline` is initially a minimal container referencing resource-managed dynamic code copied from the existing Eidolon chain; internal history anchoring, backward split selection, compaction, provider handoff and runtime-context behavior are not prematurely decomposed into many declarative XNL nodes.

Because official DeepSeek quota is nearly exhausted, reopened live evidence uses a configured compatible DeepSeek gateway and is labelled compatible-provider evidence. The SiliconFlow first pass is retained as a timeout incident; per the user's subsequent decision, the active matrix uses `deepseek-iqingwa/deepseek-v4-pro`. The historical G1-G7 official evidence remains intact and is not relabelled or replaced.
