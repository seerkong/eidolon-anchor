# 变更：迁移 MessageHistoryGraph 到 Unified DataGraph

## 背景和动机 (Context And Why)

升级到 `depa-data-graph-core@1.0.1` 后，MessageHistoryGraph 仍导入已删除的
`ReducerProjection` API，导致 Cell package aggregation 无法加载，并阻断其他
foundation 测试。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 用 `DataGraph` source 加 stream-driven state signal 替换旧 reducer projection。
- 保持现有 transcript fixtures、listener、completion、anomaly 与 dispose 行为。
- 恢复 `@cell/ai-core-logic` 聚合入口在 1.0.1 下的可加载性。

**非目标:**
- 不迁移 terminal ExecProtocolGraph。
- 不改变 history reducer 的领域规则、消息格式或消费者 API。

## 变更内容（What Changes）

- **BREAKING internal dependency migration:** 删除已移除的 projection import，
  引入 graph-owned state-node 生命周期。
- 更新仅覆盖该迁移所需的 source-inspection 或 behavior regression。

## 影响范围（Impact）

- behaviors：`vendor-data-graph-stream-foundations`
- 代码：MessageHistoryGraph 与其 focused tests。
