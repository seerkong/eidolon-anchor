# Knowledge Context

## Source Notes
| Source | Summary | Relevance |
|--------|---------|-----------|
| codument/specs/aiagent-fiber-orchestration/spec.md | Defines orchestrator as the unique scheduling authority, cooperative step state machine, control cancel migration, child fiber semantics, and mailbox priority expectations. | Primary capability to extend with durable control-signal semantics. |
| codument/specs/aiagent-persistence-recovery/spec.md | Defines session-scoped durable runtime snapshots, all-mailbox durability, fiber metadata recovery, actor transcript recovery, and conservative recovery rules. | Primary capability to extend with durable control event recovery and snapshot invariants. |
| codument/specs/ai-agent-vm-rx-data-plane/spec.md | Defines stream/signal separation and VM public/private RxData fields. | Data-plane capability to extend with control signal stream and scheduler projection. |
| cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts | Contains cooperative phases for drain, compression, LLM wait, tool wait, questionnaire parsing, and cancel handling. | Main execution state machine that will emit and consume typed control signals. |
| cell/packages/ai-organ-logic/src/OrchestratorDriver.ts | Contains resume, suspend, tick, pending resume, and fiber actor dispatch behavior. | Main control-plane scheduler integration point. |
| cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts | Serializes fiber metadata and cooperative exec state and performs recovery readiness checks. | Main persistence/recovery integration point. |

## Codebase Knowledge
- Fiber execution is cooperative: a step runs to a safe boundary and returns `yield`, `suspend`, `complete`, `cancel`, or `fail`.
- `aiGenerated`, `toolResult`, `childDone`, `humanInput`, `memberInbox`, `coordination`, `heartbeatWake`, and `control` are mailbox categories with distinct semantics.
- `control.kind=cancel_requested` is already the canonical cancel channel.
- `waitingReason=external` is too coarse to safely recover async waits and should not represent every suspended phase.
- `resumeFiber` is currently an imperative scheduling signal; unblock-capable mailbox enqueue should become the scheduling signal source.

## Domain Knowledge
- In an actor system, a message arriving while the actor is running must not re-enter the actor handler. It either waits in the mailbox or sets an interrupt flag observed by the current run.
- Interrupt is a cooperative cancellation protocol, not concurrent execution.
- Stream events record history and causality. Signals/projections expose current state. Control recovery should use durable events plus actor state, not UI/history projections.
- Outbox/inbox patterns are appropriate when a side effect must survive a crash between persistence and delivery.

## Terms
| Term | Meaning |
|------|---------|
| Durable control signal | A persisted event that can unblock, interrupt, or resume a fiber and can be replayed after recovery. |
| Interrupt message | A high-priority control message such as cancel or shutdown that can abort current in-flight async work. |
| Wake message | A message such as tool result, LLM completion, child completion, or human input that can make a suspended fiber ready. |
| Ordinary mailbox message | A non-interrupting message that is ordered in its category and processed at the next drain boundary. |
| Safe boundary | A cooperative state-machine point at which fiber state can be persisted and resumed deterministically. |
| Projection | A derived read model such as transcript/history, not the primary source of control truth. |
