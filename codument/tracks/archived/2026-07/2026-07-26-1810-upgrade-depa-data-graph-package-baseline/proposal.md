# 变更：升级 DataGraph 依赖基线

## 背景和动机 (Context And Why)

上游 `depa-data-graph` 的目标提交发布 unified `1.0.1`，并删除了旧
projection/bridge API。host 的五个直接依赖仍请求 `^0.1.0`，锁文件解析到
`0.1.1`，现有边界测试还把已删除 export 和已迁移的包路径当成契约。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 将所有直接 core/Solid manifest 和 `bun.lock` 收敛到 `1.0.1`。
- 让 vendor boundary guard 断言当前 unified public surface 与当前 AI source
  ownership。
- 为后续 API migration tracks 提供可复现的升级基线。

**非目标:**
- 不在本 track 迁移 MessageHistoryGraph、ExecProtocolGraph 或其他生产 graph
  consumer。
- 不引入保留旧 `ReducerProjection` API 的本地 shim。
- 不重置或整理既有 dirty worktree。

## 变更内容（What Changes）

- **BREAKING:** 五个 direct manifest 的 `depa-data-graph-core` / Solid range
  从 `^0.1.0` 升至 `^1.0.1`，lockfile 解析到 `1.0.1`。
- 更新 vendor surface test，删除对 removed exports 与 stale topology 的断言，
  加入可维护的 package-resolution guard。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`vendor-data-graph-stream-foundations`
- 受影响的代码：三个 Cell manifest、两个 terminal manifest、`bun.lock`，以及
  `vendor_data_graph_surface_boundary.test.ts`。
