# L3 · AICtrlWorkflow profile

`AICtrlWorkflow` is the AI-facing WorkCtrlFlow profile. Use it when a run may wait for an agent, tool, human review, timer or other durable external signal.

## Root shape

```xnl
<AICtrlWorkflow #depa.examples.SupportReview apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #depa.examples.SupportReview {
    input = "vfs://./flow-code/agent.ts#SupportReviewInput"
    output = "vfs://./flow-code/agent.ts#SupportReviewResult"
  }>
) [
  <Run #draft-context {
    src = "vfs://./flow-code/agent.ts#draftContext"
  }>
  <ExternalJob #agent-review {
    signalKind = "ai.agent.reviewed"
    signalKey = "support-review"
  }>
  <Return #done {
    src = "vfs://./flow-code/agent.ts#toResult"
  }>
]>
```

## Statements

`AICtrlWorkflow` accepts the WorkCtrlFlow statement surface:

- shared CtrlFlow statements such as `Run`, `If`, `Fallback`, `Retry`, `Timeout`, `Until`, `ForEach`, `Parallel`, `Race`, `CallFlow` and `Return`;
- WorkCtrlFlow interruptible statements such as `ExternalJob` and `Timer`.

It does not accept BPCtrlFlow-only `TaskStep` unless a future profile explicitly extends it.

## Runtime AI context

Dynamic code receives the host runtime. AI-capable runtimes include an `ai` field with roots, state store and embedded effect provider. Effects are invoked by operation name:

```ts
const run = runtime.ai.metadata.run
await runtime.ai.effects.invoke({
  effectId: "effect-1",
  operation: "ai.agent",
  input: { prompt: "Review the prepared evidence", agentType: "code" },
  run,
  nodeId: "draft-context",
  materialRefs: ["resource://depa.examples.SupportReview.Materials"]
})
```

## State and recovery

Recovery is WorkCtrlFlow-backed. AICtrlWorkflow run records project WorkCtrlFlow snapshots into AI node records and open wait handles. Node positioning must use stable ids/invocation keys, not array index.
