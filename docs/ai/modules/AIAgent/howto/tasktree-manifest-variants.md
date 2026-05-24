# TaskTree Manifest Variants

`TaskTreeRead` / `TaskTreeWrite` 现在是本仓库中第一组正式接入 `depa-processor` manifest protocol 的真实目录。

## 为什么保留目录级 `index.ts`

这里没有把目录级 `index.ts` 消灭掉，而是让它承担正式的 manifest/export 编排职责：

- 选择本目录公开哪些组件
- 指定默认导出哪个变体
- 为不同变体绑定不同 prompt / schema / config

核心逻辑仍保留在 `Logic.ts`，`index.ts` 只负责 manifest authoring。

## 当前变体

### `TaskTreeWrite`

- 默认变体：`tree`
- 额外变体：`flat`

`tree` 变体：
- 导出名为 `TaskTreeWrite`
- 支持 `replace_root` / `expand` / `update_status`
- 保持当前层级任务树语义

`flat` 变体：
- 导出名为 `TaskTreeWriteFlat`
- 只支持 `replace_root` / `update_status`
- 明确禁止 `expand`
- 通过 `config.mode = "flat"` 驱动核心逻辑行为收紧

### `TaskTreeRead`

- 默认变体：`tree`
- 额外变体：`flat`

`tree` 变体：
- 导出名为 `TaskTreeRead`
- 返回完整 task tree JSON

`flat` 变体：
- 导出名为 `TaskTreeReadFlat`
- 返回扁平任务视图
- 每个节点包含 `depth` 与 `parentId`

## 上层如何消费

项目侧通过 `taskTreeManifestBundle.ts` 暴露三类入口：

- `buildTaskTreeDefaultToolDefsFromManifest()`
  - 用于当前正式 registry
  - 只取默认 `tree` 变体
- `buildTaskTreeVariantToolDefsFromManifest()`
  - 用于测试或未来扩展场景
  - 一次导出全部 tree/flat 变体
- `buildTaskTreeRouteKeyMapFromManifest()`
  - 提供最小 route-key 组合示例

`ToolFuncBuiltin.ts` 现在已经不再直接手写 `TaskTreeRead` / `TaskTreeWrite` 的 schema/build glue，而是从 manifest 默认变体派生默认 defs。

## 后续迁移方向

这一轮只把 `TaskTreeRead` / `TaskTreeWrite` 作为真实 adoption 闭环。

后续如果继续扩展：

- 其他工具目录可沿用同样模式导出多 variant manifests
- `ToolFuncBuiltin.ts` 可逐步从静态列表过渡到 bundle-driven compose
- `@cell/composer` / `@cell/mod-sys-*` 可以在更高层消费 bundle manifest，而不必再直接依赖目录级硬编码聚合
