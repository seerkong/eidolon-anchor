## 上下文

本 track 是 mission G4：让 workflow runtime surface 复用 Eidolon detached actor registry/observability。

## 方案概览

1. `WorkflowRun`
   - validate workflow ref。
   - build workflow run prompt。
   - call existing `spawnChildExecutionActor` with detached mode.
2. `WorkflowStatus`
   - read `getDetachedActorRegistry(vm).get(run_id)`.
3. `WorkflowEvents`
   - read `getDetachedActorObservabilityStore(vm).queryMessages(run_id, ...)`.
4. `WorkflowResult`
   - read detached actor registry output/error.
5. `WorkflowResume`
   - first slice returns current detached actor status and reports whether runtime already owns scheduling; it does not create a second resume mechanism.

## 决策摘要

- Runtime facts stay in Eidolon detached actor/session machinery.
- Workflow tools expose workflow-shaped names over those facts.

## 风险 / 权衡

- This is not yet a full AIDataWorkflow DAG scheduler.
- It is the correct first runtime projection because it avoids a workflow-specific store.
