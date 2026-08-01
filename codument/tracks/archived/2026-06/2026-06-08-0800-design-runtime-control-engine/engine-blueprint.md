# Runtime Control Engine Blueprint

## Purpose
This blueprint turns the design track into an implementation-ready architecture. It assumes `depa-actor@0.2.0` is locally linked in the workspace packages that adopt the engine and provides the local execution substrate. The runtime control engine must not rebuild that substrate.

Current verification note: from `cell/packages/ai-organ-logic`, the workspace now resolves `depa-actor@0.2.0` through the local file dependency, and `createCommandDequeGroup`, `pushBackCommandToGroup`, and related execution-kernel exports are available.

## Vendor Substrate

### depa-actor@0.2.0
Use `depa-actor@0.2.0` for:

- mailbox ingress and actor-local ownership
- priority mailbox and selective receive at the external control boundary
- fiber scheduling primitives where the domain runtime needs fibers
- `CommandDequeGroup` for internal command worklists
- single `CommandDeque` for per-queue stable FIFO / front-back insertion
- group selector hooks for runtime-state-aware scheduling
- group-level reducer helpers for serializable next-state updates
- `InstructionStack`, `OperandStack`, `StackMachine`, and `dispatchInstructions` for local interpreter frames when a command expands into smaller execution steps

The engine must not add a second command deque implementation, a second stack-machine implementation, or a parallel local dispatcher.

### depa-processor
Use `depa-processor` for effect handler dispatch:

- route key / command table / path dispatch where effect handlers are selected by data
- standard component encapsulation for injected effect implementations
- manifest composition when the runtime needs handler bundles or variants

The engine must not make `depa-processor` responsible for durable effect lifecycle. It is a dispatch substrate; the control engine owns lifecycle state.

## Package Boundary Recommendation

The next implementation track should place the reusable control engine above vendor primitives and below AI-domain semantics.

Candidate package split:

- `vendor/depa-actor-control` or a new vendor control package: domain-neutral effect lifecycle, safepoint coordinator, durable cohort, recovery classifier, and conformance harness.
- `cell/packages/ai-runtime-control-contract`: AI-facing contracts that name AI runtime durable heads and semantic commands.
- `cell/packages/ai-runtime-control-logic`: AI-domain mapping from mailbox/conversation/snapshot/tool-result/diagnostics to vendor engine commands, effects, and durable heads.

If the vendor package is created, it should depend on `depa-actor@0.2.0` and `depa-processor`, but must not import AI packages.

## Core Data Model

```ts
type ControlCommandId = string

type ControlCommand =
  | { kind: 'ingress.accepted'; id: ControlCommandId; ingressId: string }
  | { kind: 'effect.request'; id: ControlCommandId; effectId: string }
  | { kind: 'effect.result'; id: ControlCommandId; effectId: string; resultId: string }
  | { kind: 'safepoint.evaluate'; id: ControlCommandId }
  | { kind: 'cohort.commit'; id: ControlCommandId; cohortId: string }
  | { kind: 'recovery.classify'; id: ControlCommandId }
  | { kind: 'maintenance.tick'; id: ControlCommandId }

interface ControlState {
  commands: CommandDequeGroupState<ControlCommand>
  effects: Record<string, EffectLifecycleRecord>
  heads: Record<string, DurableHeadState>
  cohorts: Record<string, DurableCohortState>
  recovery: RecoveryState
  projection: ControlProjection
}
```

The exact command union can evolve, but it should stay data-only. Scheduling metadata belongs to the `CommandDequeGroup` deque definitions, not to individual command items.

## Recommended Internal Queues

Default command group definitions:

```ts
const commandDeques = [
  { id: 'control', priority: 1, lane: 'control' },
  { id: 'effectResult', priority: 5, lane: 'result' },
  { id: 'resume', priority: 10, lane: 'control' },
  { id: 'safepoint', priority: 15, lane: 'commit' },
  { id: 'commit', priority: 20, lane: 'commit' },
  { id: 'normal', priority: 50, lane: 'work' },
  { id: 'maintenance', priority: 80, lane: 'background' },
]
```

The selector must receive runtime state and decide what is currently consumable.

Examples:

- `control` can always preempt normal work.
- `effectResult` should be consumed before normal reduction so tool/effect pairings close promptly.
- `commit` is only consumable when safepoint policy allows the relevant durable cohort.
- `safepoint` evaluates readiness and may enqueue `commit`; it is consumed during long-running turns and must not wait for an outer interactive-turn boundary.
- `normal` is gated while the engine is waiting for a blocking external condition.
- `maintenance` can use aging in the selector to avoid starvation.

## Effect Lifecycle

Effects are data and must be tracked independently of processor handler invocation.

```ts
type EffectStatus =
  | 'requested'
  | 'dispatching'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'

interface EffectLifecycleRecord {
  effectId: string
  routeKey: string
  idempotencyKey: string
  status: EffectStatus
  requestedByCommandId: string
  startedAt?: number
  completedAt?: number
  waitReason?: string
  resultRef?: string
  error?: string
}
```

Long-running effects, permission waits, human waits, and external process waits must be explicit lifecycle states. The engine must not rely on an in-memory Promise alone as the source of truth.

## Safepoint Policy

A safepoint is a predicate over state, durable head buffers, and effect lifecycle records.

```ts
interface SafepointDecision {
  allowed: boolean
  blockedBy: string[]
  cohortId?: string
}
```

Rules:

- If any durable head required by a cohort is not ready, the cohort commit command remains pending or unselected.
- If an effect is in a non-recoverable in-memory-only state, snapshot heads must not advance past it.
- Conversation, mailbox, snapshot, diagnostics, ingress, and effect evidence heads should advance together only through the cohort commit path.

## Durable Cohort

A durable cohort groups related heads and commits them as one consistency boundary.

```ts
interface DurableCohortState {
  cohortId: string
  headIds: string[]
  expectedSequences: Record<string, number>
  commitMarker?: string
  status: 'open' | 'ready' | 'committing' | 'committed' | 'dirty'
}
```

The first implementation can use file-backed append-only heads, but the engine contract should stay storage-port based.

## Fine-Grained Checkpoint Scheduling

Checkpoint scheduling is part of the command interpreter, not a callback after a whole TUI or interactive turn completes.

Required behavior:

1. A state-mutating command that buffers a durable head also enqueues `safepoint.evaluate` for each cohort that includes that head.
2. `safepoint.evaluate` checks the current state, effect lifecycle, and durable head readiness.
3. If the cohort is safe and no commit command for that cohort is already queued, it enqueues `cohort.commit`.
4. `cohort.commit` remains selector-gated and only consumes when every required head is buffered.
5. If the engine keeps running for many LLM/tool steps, each semantic boundary can still evaluate and commit a checkpoint; no checkpoint may depend on the outer `enqueue()`/interactive-turn function returning.

This is saga-like because effect intent/result records and cohort commits form a recoverable lifecycle. It is not a database transaction clone: most AI effects cannot be compensated or replayed safely, so recovery classification and continuation are the main correctness tools.

## Recovery Classification

Recovery must classify inconsistent durable heads instead of silently accepting dirty state.

Minimum classes:

- `clean`: all heads agree with commit markers
- `pending`: command/effect can continue without re-executing unsafe side effects
- `retryable`: effect request is safe to dispatch again using idempotency key
- `orphaned`: effect result exists without a matching request or command record
- `dirty`: persisted heads disagree and require repair before resume

## AI Adoption Boundary

AI runtime adoption should map AI concepts into the control engine without leaking them into vendor primitives.

Examples:

- human input -> ingress command + conversation head buffer
- tool call request -> effect request + tool-call evidence head
- tool output -> effect result command + conversation/evidence head buffer
- mailbox delivery -> ingress/effect-result/control command depending on source
- snapshot save -> safepoint evaluation + durable cohort commit
- diagnostics stream -> diagnostics head buffer included in safe cohorts when required

## Conformance Harness

Before replacing AI runtime paths, create a conformance test suite with:

- fake clock
- fake `CommandDequeGroup` selector inputs
- fake depa-processor effect handlers
- fake append-only durable heads
- crash injection between command accepted, effect requested, effect started, effect result persisted, cohort commit started, and commit marker written
- long interactive-turn simulation where many head buffers are produced before the outer turn returns; the harness must show checkpoint commits happen inside the command stream
- replay assertions after every injected crash point

## Implementation Order

1. Define domain-neutral effect lifecycle, durable head, cohort, safepoint, and recovery types.
2. Keep adopting workspace package resolution on `depa-actor@0.2.0` or later so execution-kernel exports are available.
3. Build pure reducers that take `ControlState` and commands and return next state plus effect dispatch intents.
4. Use `CommandDequeGroup` reducer helpers for serializable command group updates.
5. Wrap depa-processor dispatch as an injected effect port.
6. Add file-head fake storage and crash-injection conformance tests.
7. Only after conformance passes, add AI-domain wrappers in `ai-runtime-control-*` packages.
