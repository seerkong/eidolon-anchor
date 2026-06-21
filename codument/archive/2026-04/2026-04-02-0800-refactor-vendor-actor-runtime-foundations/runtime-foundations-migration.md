# Runtime Foundations Migration Notes

## 本轮进入 vendor 的内容

- `CompletionSignalRegistry`
- `CompletionBindingRegistry`
- `RuntimeSnapshotManifestBase`
- `RuntimeRootSnapshotBase`
- `ActorSnapshotBase`
- `FiberSnapshotBase`
- `SnapshotCodec`
- `RecoveryHooks`
- `PersistenceEffectPort`
- `RuntimeIndexHook`
- `ActorRuntime` facet 挂载能力

这些能力都属于通用 actor runtime 机制，不依赖 AI-specific 业务语义。

## 本轮第一批 adoption

- `VmRuntimeContext`
  - 从 VM 裸字段继续存在，收口为通过 `ActorRuntime` facet 正式挂载的 runtime context
  - collective / formation final waiters 改为建立在 `CompletionSignalRegistry` 上
- `OrchestratorDriver`
  - child completion binding 改为建立在 `CompletionBindingRegistry` 上
  - fiber context 管理改为建立在 `RuntimeIndexHook` 上
- runtime snapshot / recovery
  - actor / vm / fiber / manifest snapshot 类型改为建立在 vendor snapshot base contracts 之上
  - actor / vm snapshot serialize / hydrate 改为通过 vendor snapshot protocol 壳暴露

## 仍保留在项目层的内容

- `TaskTree`
- `planApproval`
- `shutdownCoordination`
- `collectiveState`
- `formationState`
- questionnaire / detached / organization 的 AI-specific 业务语义
- runtime snapshot 的 AI-specific product-state codec 与外层 persistence adapter

## 当前残留

- `vendor/depa-actor` 的 README 和独立 foundation 文档已补齐，但更完整的 API 示例仍可在下一轮补充。
- actor / fiber index hook 当前已经有真实 adoption，但尚未全面替换项目内所有可能的派生索引面。
- runtime snapshot 的 repository / file layout 仍在项目层，这符合本 track 的边界。
- `vendor/depa-data-graph` / stream foundation 改动已从当前 actor runtime track 工作树中移除，保持 capability 边界单独演进。
