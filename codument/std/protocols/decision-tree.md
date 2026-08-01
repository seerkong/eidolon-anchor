# Decision Tree Protocol

Decision-tree is the shared planning protocol for `plan-track`, `plan-mission`, `discuss`, and `maintain-track`. It turns unresolved choices into a bounded **topological question frontier**; it is not a distributed skill and does not require a separate agent invocation.

## Severity

Use `auto`, `light`, `normal`, or `deep` as defined by `questioning.md`. `auto` asks no routine questions: inspect local evidence, choose the conservative default, and record the assumption. Other modes ask only choices that local evidence cannot resolve.

## Storage

- Every new track and mission has a valid root `decisions.xnl` as its single process-decision carrier.
- Use `analysis/decision-tree.xnl` only when a complex frontier needs working memory; it is optional and is not a second decision source.
- Create `decisions/` only for eligible durable legacy records. Create `memory/` only for eligible reusable memory.

## Decision Forest And Dependencies

`decisions.xnl` is a forest, not a serial questionnaire.

- Each root `<decision>` is an independent direction until evidence or an explicit dependency says otherwise.
- A nested `<decision>` is a refinement of its parent. Its parent is an implicit prerequisite: do not ask the child before the parent reaches a resolved status.
- Use `depends_on = ["decision-id" ...]` on a decision for additional cross-branch prerequisites. Do not use `blocks` for this graph: `blocks` names the work materially blocked by an unresolved decision.
- A resolved status is `accepted`, `resolved`, or `deferred`. If an answer makes a child irrelevant, record that conclusion and resolve the child rather than leaving a dead pending node.
- The dependency graph MUST be acyclic. If local evidence exposes a cycle or an unknown dependency id, record the issue and ask only the minimal clarification needed to repair the graph.

## Conditional Decision Activation

The forest may grow after a batch is answered. A combination of independent
choices can make a new question applicable even when it is neither a child of
one source decision nor known as a ready question at the start.

- `depends_on` says which decision records must be resolved before a node can be ready.
- `activation` says which selected values make a candidate decision applicable. Use an `all` list for a required combination and an `any` list for alternatives.
- `derived_from` is written when the node is materialized. It records the actual `decision-id=selected-value` facts that activated the question.
- A generated decision is normally added as a **same-level peer** with all source ids in `depends_on`; do not force a multi-root concern under one arbitrary parent.
- After every answer batch, evaluate declared activation rules using resolved answers. Materialize only satisfied candidates as `status = "pending"`; leave unsatisfied candidates unasked. Then recompute the topological ready set.

Minimal example: `deployment` and `compliance` start as independent roots.
Only the combination `self_hosted + regulated` creates the peer question
`key_management`:

```xnl
<decision #mission.example.deployment {
  status = "accepted"
  priority = "P0"
}
(
  <answer { }
  (
    <decision-text ?>self_hosted</?>
  )>
)>

<decision #mission.example.compliance {
  status = "accepted"
  priority = "P0"
}
(
  <answer { }
  (
    <decision-text ?>regulated</?>
  )>
)>

<decision #mission.example.key_management {
  status = "pending"
  priority = "P0"
  depends_on = ["mission.example.deployment" "mission.example.compliance"]
  activation = {
    all = [
      "mission.example.deployment=self_hosted"
      "mission.example.compliance=regulated"
    ]
  }
  derived_from = [
    "mission.example.deployment=self_hosted"
    "mission.example.compliance=regulated"
  ]
}
(
  <question ?>受监管的自托管部署中，密钥应如何托管？</?>
  <recommendation ?>使用受审计的专用密钥管理服务。</?>
)>
```

In this example the first two decisions can be asked together. The third is
created only after both answers are known, then enters the next ready batch.
`activation` is a protocol field interpreted by the planning agent; ordinary
decision validation continues to validate XNL structure and answer records.

## Topological Question Batches

Before each user interaction, build the pending-decision graph and compute its ready set:

1. Read local evidence first and resolve any decision that does not need user intent.
2. Find every pending decision whose parent and every `depends_on` target are resolved. These zero-unresolved-dependency nodes are the **topological frontier**.
3. Sort the frontier by priority (`P0`, `P1`, `P2`), then by stable decision id. Select all highest-priority ready directions that fit the current severity's per-round budget; use remaining capacity for lower-priority ready directions.
4. Ask the selected nodes in **one** multi-question interaction. Each question carries its decision id, recommendation, options, and tradeoff. Do not descend one root while another ready root remains unasked merely because it appeared first in the file.
5. Write every answer and its rationale/evidence to the corresponding `decisions.xnl` record. Recompute the graph; newly unlocked children join the next batch.

This is breadth-first refinement across independent directions and depth-first only where dependencies require it. A batch is not an invitation to repeat already resolved questions or to ask blocked descendants speculatively.

## Procedure

1. Read code, tests, owner registries, prior decisions, and the relevant project constraints.
2. Separate resolved facts from choices that block the next irreversible action, recording parent/child and explicit cross-branch dependencies.
3. Record each unresolved choice in `decisions.xnl` with evidence, recommendation, status, and `depends_on` where needed.
4. When the selected severity permits interaction, ask the current topological batch as one multi-question interaction.
5. Write every accepted result back to the same records, recompute the ready set, then continue the plan or ask the next batch.

The XNL shape and decision record validity rules are defined by `std/spec/xnl-format.md` and validated with `codument decisions validate`.
