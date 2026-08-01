# 设计：holon 内部实现命名收口

## 1. 上下文

正式 rename 已经完成，但当前仓库里还保留两类 `collective / formation`：

1. **必须保留为历史/兼容边界的旧名**
   - 例如 legacy internal-only tool family
   - 例如旧 snapshot fail-fast 文案
   - 例如历史分析报告中的迁移前术语

2. **仍占据主实现路径的旧名**
   - `collectiveTaskSignals` / `formationRouteSignals`
   - `collectiveEnvelope.ts` / `formationEnvelope.ts`
   - `_collectiveAssignCore.ts` / `_formationAssignCore.ts`
   - `RuntimeCollectiveController` / `CollectiveTaskRunner`
   - `OrganizationManager.createCollective/createFormation` 等 API

本 track 只针对第二类。

## 2. 设计目标

### 2.1 主实现路径统一回到 holon/governance

内部代码不再把：

- `collective = 一种组织类型`
- `formation = 另一种组织类型`

当作主心智，而是回到：

- `holon(governance=autonomous)`
- `holon(governance=leader_led)`

### 2.2 保留边界必须显式化

如果某些旧名暂时不能动，需要把它们明确标成：

- lane/workload 语义
- 历史协议
- legacy adapter

而不是让它们继续散落在主实现路径里。

## 3. 命名收口策略

### 3.1 manager API

优先方向：

- `createCollective/createFormation` -> holon-first API
- `addCollectiveMember/addFormationMember` -> `addHolonMember`
- `setCollectiveWatchState/setFormationWatchState` -> `setHolonWatchState`
- `resolveCollective/resolveFormation` 保留为治理分支 helper 或 alias，不再作为默认入口

### 3.2 signal store

当前：

- `collectiveTaskSignals`
- `formationRouteSignals`

目标：

- 用能明确表达治理差异的名字收口
- 让调用方从“旧组织类型”切回“holon 行为分支”

本轮倾向命名：

- `autonomousHolonTaskSignals`
- `leaderLedHolonRouteSignals`

### 3.3 envelope / protocol / assign core

当前：

- `collectiveEnvelope.ts`
- `formationEnvelope.ts`
- `_collectiveAssignCore.ts`
- `_formationAssignCore.ts`

目标：

- 让“自治任务板协议”和“leader 路由协议”从名字上就可直接对应治理分支

本轮倾向命名：

- `autonomousHolonEnvelope.ts`
- `leaderLedHolonEnvelope.ts`
- `_autonomousHolonAssignCore.ts`
- `_leaderLedHolonAssignCore.ts`

### 3.4 runtime components

当前：

- `RuntimeCollectiveController`
- `CollectiveTaskRunner`

目标：

- 名称直接表达“autonomous holon board claim / dispatch loop”

本轮倾向命名：

- `AutonomousHolonController`
- `AutonomousHolonTaskRunner`

## 4. 暂保留项

### 4.1 lane / workload

`AI_AGENT_LANES.collective` 与 `AI_AGENT_WORKLOADS.collectiveTask` 同时承担调度语义。它们是否继续改名，要看是否值得做跨层大规模波及。

默认策略：

- 本 track 先允许保留
- 但必须在文档中明确它们只是内部调度名，不是正式组织类别

### 4.2 task-tree `activeForm`

`activeForm` 中仍有 `collective:` / `formation:` 前缀。它涉及：

- task tree scope
- claim 过滤
- 历史/恢复语义

默认策略：

- 先作为独立子问题评估
- 若本轮修改成本可控，再纳入
- 若波及过大，则在设计中明确推迟

## 5. 风险

### 5.1 高风险

- rename signal store 后，wait/final settlement 断裂
- envelope / assign core 重命名后，message loop 与 route-back 断裂
- manager API 替换不完全，导致调用路径混用新旧入口

### 5.2 中风险

- internal-only legacy tools 仍反向依赖旧 helper 名称
- tests 混用 default baseline 与 legacy alias，导致覆盖边界重新模糊

## 6. 实施顺序

1. 先收口 manager API 与 signal store 命名
2. 再收口 envelope / assign core / executor helper 命名
3. 再评估 controller / task runner 与 activeForm 是否一并改写
4. 最后同步 focused tests、theater 报告与相关 specs
