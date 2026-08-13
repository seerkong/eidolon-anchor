# L3 · AIDataWorkflow profile

`AIDataWorkflow` is the AI-facing EagerDataFlow profile. Use it when AI work is best represented as a DAG whose nodes can be patched, invalidated and reused inside a long-running run.

## Root shape

```xnl
<AIDataWorkflow #depa.examples.SupportEvidenceDag apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #depa.examples.SupportEvidenceDag {
    inputPorts = ["ticket"]
    outputPorts = ["summary"]
  }>
) [
  <EntryNode #entry>
  <TransformNode #retrieve {
    inputs = { ticket = "flow-port://#entry/ticket" }
    outputs = ["evidence"]
    src = "vfs://./flow-code/evidence.ts#retrieveEvidence"
  }>
  <TransformNode #summarize {
    inputs = { evidence = "flow-port://#retrieve/evidence" }
    outputs = ["summary"]
    src = "vfs://./flow-code/evidence.ts#summarizeEvidence"
  }>
  <ReturnNode #return {
    inputs = { summary = "flow-port://#summarize/summary" }
  }>
]>
```

## Nodes

`AIDataWorkflow` accepts the EagerDataFlow node surface:

- `EntryNode`
- `TransformNode`
- `SinkNode`
- `SubFlowNode`
- `ReturnNode`

`flow-port://#node/port` creates a data dependency. `flow-node://#node` creates a completion dependency through `waitFor`.

## RunGraph state

The XNL definition produces an EagerDataFlow authoring plan. At run time, AIDataWorkflow creates a RunGraph with:

- node status and generation;
- patch history;
- transitive invalidation records;
- node-level reuse policy and semantic fingerprints.

Definition edits and RunGraph patches are separate surfaces. A run patch does not rewrite the XNL definition.

## Reuse policy

Machine nodes default to `semantic-hash`; manual nodes default to `never`. Author a canonical manual node through AIDataWorkflow config:

```xnl
<TransformNode #human-review {
  inputs = { evidence = "flow-port://#retrieve/evidence" }
  outputs = ["review"]
  src = "vfs://./flow-code/evidence.ts#reviewEvidence"
  config = { node_type = "manual" }
}>
```

`node_type = "manual"` is AIDataWorkflow policy metadata. EagerDataFlow's legacy `type` field remains an implementation binding. A node may override its reuse policy with config such as:

```xnl
<TransformNode #fresh-review {
  inputs = { evidence = "flow-port://#retrieve/evidence" }
  outputs = ["review"]
  src = "vfs://./flow-code/evidence.ts#reviewEvidence"
  config = { reuse_policy = "never" }
}>
```

Semantic reuse is run-local. Generation is history metadata and is not part of the reuse fingerprint.
