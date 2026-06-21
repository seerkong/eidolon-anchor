# 设计：member / holon / primary 命名收口

## 1. 上下文

当前运行时已经完成 actor 化，`collective` 与 `formation` 都拥有真实 actor、真实 fiber 与 actor-owned state。问题已经不是“它们是否真实存在”，而是当前正式命名把：

- 组织对象类别
- 治理差异
- 执行语义

混在了同一层。

具体问题：

- `collective / formation` 同时承担“组织类别”与“治理差异”两层语义
- `control` 与 orchestrator / controller / session 等概念容易混淆
- `/collective`、`/formation` 两个一级命令面让组织命令体系分裂
- `::` 作为文本分隔符不符合用户的命令行直觉

## 2. 目标模型

### 2.1 组织轴

- `member`
- `holon`

### 2.2 治理轴

- `governance = autonomous | leader_led`

映射：

- 原 `collective` -> `holon(governance=autonomous)`
- 原 `formation` -> `holon(governance=leader_led)`

### 2.3 执行轴

- `primary`
- `delegate`
- `detached`

映射：

- 原 `control` -> `primary`

## 3. 设计原则

### 3.1 先做正式 rename，不顺手重构业务机制

本次 track 的主要目标是正式命名统一，而不是重新设计组织机制。

因此第一阶段保留：

- `memberIds`
- `leaderMemberId`
- `tasks`
- `taskOwnership`
- `routes`

### 3.2 避免双模型长期并存

不建议长期保留：

- `collectiveState + holonState`
- `collectives/formations + holons`
- `control + primary`
- `Collective* / Formation* + Holon*`

如果需要短期兼容，应只保留 parser alias，不保留正式双字段。

### 3.3 `/holon` 取代 `/collective` 与 `/formation`

对外命令面应统一成一个 typed namespace：

- `/holon create <governance> <name>`
- `/holon add <holon> <member>`
- `/holon appoint <holon> <member>`
- `/holon status <target>`
- `/holon assign[:mode] <target> -- <content>`

其中：

- `/holon appoint` 只对 `leader_led` 有意义
- `assign / watch / unwatch` 协议保持不变

### 3.4 `--` 作为自由文本分隔符

统一规则：

- `--` 前放结构化参数
- `--` 后放 prompt/content
- 不带自由文本的命令不出现 `--`

## 4. 需要统一替换的层

### 4.1 formal contract

- `ACTOR_ORGANIZATION_KINDS`
- `RuntimeSlashCommandNamespace`
- `DEFAULT_KERNEL_SLASH_COMMAND_SURFACES`

### 4.2 runtime truth

- `identity.kind`
- `identity.governance`
- `actor.type`
- actor key 前缀
- `holonState`
- `sessionState.holons`

### 4.3 protocol values

- envelope tag / payload 中的组织名
- `activeForm` 前缀
- route / task summary 聚合时使用的组织前缀

### 4.4 persistence

- snapshot VM sessionState 结构
- snapshot actor state 结构
- recovery hydrate 路径

### 4.5 tool / slash / docs / tests

- `Collective*` / `Formation*` -> `Holon*`
- `/collective` `/formation` -> `/holon`
- `::` -> `--`
- help / tips / prompt / docs / tests 同步切换

## 5. 兼容策略

### 5.1 推荐策略

推荐：

- 正式 surface 一次性切换
- 旧 slash 仅作为短期 deprecated alias
- 旧 snapshot 不承诺兼容恢复

### 5.2 不推荐策略

不推荐：

- 在 runtime 中长期保留旧字段
- 在 tool registry 中长期保留两套正式工具族
- 在 docs/help 中继续展示旧命令面

## 6. 风险

### 6.1 高风险

- actor key 与 resolve 路径不同步
- snapshot schema 与 runtime truth 不同步
- `activeForm`、task summary、route 聚合遗留旧前缀
- parser / help / tips / tests 不同步

### 6.2 中风险

- `collective lane`
- `collectiveTaskSignals`
- `formationRouteSignals`

这些是否一起改名，要看实现阶段是否把它们视为正式业务语义。

## 7. 实施顺序

1. 先改 formal spec 与 contract
2. 再改 runtime truth
3. 再改 envelope / activeForm / protocol values
4. 再改 tool family 与 slash parser
5. 再改 help / tips / prompt / tests / docs
6. 最后改 snapshot / recovery 并明确 breaking 边界
