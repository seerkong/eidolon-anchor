# Design

## Decision Summary

### 1. Delivery fact belongs to runtime/domain metadata

每个新提交的普通 tool result 注册 `pending` delivery fact，身份至少包含 actor 与 `tool_call_id`。provider materializer 构造 request 时收集其中实际包含的 pending pair；只有该 provider call 成功完成，才批量确认这些 pair 为 `delivered`。失败、中止或进程恢复保留 pending。

legacy session 中没有 delivery fact 的旧结果按“已交付或可由既有 compaction 管理”兼容，避免把全部历史重新塞进 provider。

### 2. Compaction protects pending results

cheap compaction 和 micro compaction 接收 pending `tool_call_id` 集合，不得把匹配结果替换成“already received” wrapper。它们仍可压缩旧 summary 和已交付结果，为 pending 结果腾出空间。若 pending 结果本身无法放入 provider 上限，应显式失败或进入后续有界分片协议，不能谎称已交付。

这同时修复 artifact recursion：artifact read 产生的新 tool result 也是 pending，因此至少完整进入一次成功 provider request 后才可再次外置。

### 3. Cache-friendly provider shape

delivery 状态不进入 system instructions、provider cache key 或静态 prompt assembly。它只影响 late conversation materialization 中本来就会变化的 tool result 内容，因此保持稳定前缀和 Responses stateless request 的 cache 友好性质。

### 4. Detached single-flight uses deterministic scope

detached `RunDelegateActor` 使用 `(parent actor identity, agent type, task_key)` 作为单飞 scope。`task_key` 缺省为 `default`：

- scope 中已有 `pending/running/suspended` task 时，返回原 `task_id`、当前状态和 `reused=true`；
- scope 进入 completed/failed/cancelled 等终态后释放；
- 调用者用不同显式 `task_key` 表达确实需要的并行工作；
- `sync_wait` 不参与该默认 detached 单飞约束。

该方案是 actor 资源所有权约束，不依赖 prompt 文本相似度，也不是通用循环守卫。

## Data and Ownership

- Conversation/session owner 持有 provider delivery fact，并负责持久化与恢复。
- Executor 负责记录 request 实际包含的 pending pair，并在成功 provider completion 后发送确认命令。
- Context compressor 只消费 pending id 集合做纯保护决策，不拥有 delivery 状态。
- Detached actor registry 持有 active single-flight scope 到 task id 的索引，并在终态原子释放。
- Delegate tool 只暴露 `task_key` 输入和结构化 reused 输出，不自行维护并发真相。

## Failure and Recovery

- provider transport 抛错、流中断、cooperative yield 或 actor abort 不确认 delivery。
- snapshot 恢复后 pending fact 继续保护结果；已确认 fact 可继续压缩。
- registry 恢复出仍可续跑的 `pending`、`running` 或 `suspended` task 时，应重建 active scope 并继续复用。
- runtime 无法续跑而把 task 投影为 `interrupted` 时，应保留 task 与 scope 审计数据，但释放 active scope，使后续同 scope 调用创建新 task。
- 终态释放必须幂等，避免重复 completion event 破坏后续 task。

## Compatibility

- 不迁移 legacy History；无 delivery fact 的旧结果沿用既有预算行为。
- `task_key` 为可选字段；现有 detached 调用默认进入单飞槽位。
- 现有显式多 explorer 并行调用需要补不同 `task_key`，这是有意的资源安全收紧。

## Test Strategy

1. live executor 测试：旧历史超过 120 KB，刚产生约 26 KB 结果，下一 request 必须含完整结果。
2. provider success/failure/abort 和 snapshot round-trip 测试。
3. 大 artifact read 后不产生第二层 artifact 的收敛测试。
4. detached registry/tool 测试：default scope 复用、显式 key 并行、终态释放、父 actor 隔离。
5. 事故组合回归：统计首次 request 内容、artifact 数量和 child actor 数量。
6. 受影响包测试、类型检查以及 provider request shape/cache spot-check。

## Risks

- pending 大结果可能抬高单次 provider token 使用；实现应优先压缩已交付历史，并对超出硬上限给出明确诊断。
- 默认单飞会改变隐式同类型并行行为；`task_key` 是显式兼容出口。
- 当前工作树包含其他 mission 改动；实现必须只增量编辑目标文件并避免重置或清理。
