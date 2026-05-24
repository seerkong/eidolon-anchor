# 变更：将 holon runtime protocol 中的 collective lane/workload/scope marker 收口

## 背景

当前 formal surface、runtime helper、legacy tool alias 与 autonomous runtime event wording 已经基本收口完成，但还保留三类协议级旧名：

- scheduler lane: `collective`
- workload label: `collective_task`
- task-tree scope marker: `collective:<id>` / `formation:<id>`

这些名字已经不是正式对象模型，但仍然进入 fiber/snapshot/task-tree 等 runtime protocol。

## 变更内容

- 将 lane `collective` 重命名为 `autonomous_holon`
- 将 workload `collective_task` 重命名为 `autonomous_holon_task`
- 将 task-tree scope marker 改为：
  - `holon:autonomous:<id>`
  - `holon:leader_led:<id>`
- 将 runtime snapshot schema version 升级，并让旧协议数据 fail-fast

## 非目标

- 不删除 legacy tool family
- 不处理 envelope tag `<collective_task>` 这一层协议文本
- 不修改 vendor/depa-actor 的历史测试与示例

## 影响范围

- `cell/packages/organ-logic/src/lane/*`
- `cell/packages/organ-logic/src/organization/*`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/ActorStatus/Logic.ts`
- `cell/packages/organ-logic/src/persistence/RuntimeSnapshots.ts`
- `cell/packages/core-logic/src/runtime/*snapshot*`
- runtime recovery / lane semantics / task runner 相关 tests
