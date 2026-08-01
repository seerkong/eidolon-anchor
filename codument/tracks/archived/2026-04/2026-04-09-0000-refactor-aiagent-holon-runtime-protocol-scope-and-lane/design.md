# 设计：runtime protocol scope/lane 重命名

## 范围

本轮绑定处理以下三类 protocol 真相：

1. lane `collective`
2. workload `collective_task`
3. `activeForm` 中的 `collective:` / `formation:` marker

## 命名

- lane:
  - `member`
  - `autonomous_holon`
  - `detached`
  - `interactive`
- workload:
  - `autonomous_holon_task`
- task-tree scope:
  - `holon:autonomous:<id>`
  - `holon:leader_led:<id>`

## 方案

- 新增 shared helper 统一生成和解析 holon task scope
- lane/workload 常量直接切到新值
- `MemberManager`、`OrganizationManager`、`AutonomousHolonTaskRunner`、`ActorStatus` 跟随改写
- runtime snapshot schema version 升级
- recovery 不再接受旧协议命名

## 关键决策

| 决策 | 理由 |
|------|------|
| 这次 protocol rename 采用 schema bump + fail-fast | lane/workload/activeForm 都会进入 snapshot，长期双协议兼容代价过高 |
| scope marker 采用 `holon:<governance>:<id>` | 与当前 formal `holon + governance` 心智一致，且可直接从字符串恢复治理语义 |
| 本轮不处理 `<collective_task>` envelope tag | 先把影响 recovery/scheduler/task-tree 的真协议清掉，避免范围继续外溢 |

## 验证

- `lane_semantics.test.ts`
- `collective_runner_claim_idle_work.test.ts`
- `runtime_recovery.test.ts`
- `runtime_snapshot_repository.test.ts`
- `organization_tools.test.ts`
- `codument validate refactor-aiagent-holon-runtime-protocol-scope-and-lane --strict`
