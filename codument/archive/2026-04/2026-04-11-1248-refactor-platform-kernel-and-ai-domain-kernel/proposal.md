# 变更：将当前 AI 运行时演进为平台微内核与 AI 领域微内核

## 背景和动机

当前项目已经具备较强的微内核候选基础：

- `vendor/depa-actor` 已提供 actor、typed mailbox、fiber orchestration、persistence port 等通用运行时原语
- `vendor/depa-processor` 已提供 manifest、variant、bundle composition、dispatch/router 等组合原语
- `vendor/depa-data-graph` 已提供 timeline、append-only log、reducer projection、模块化 node identity
- `cell` 侧已经开始把默认 capability 从 runtime entry 中下沉到 `composer + mod profile + mod-sys-*`

但当前 `cell/core-*` 与 `composer` 仍带有明显 AI 领域形状，例如 `AiAgentVm`、`AgentConfig`、`ToolSchema`、`actor/member/holon` slash contract、AI 专属 persistence/effect surfaces。若未来出现新的非 AI 领域，继续复制一套“针对性微内核”会带来重复的 profile、registry、hook、projection、persistence、shell bridge 和 diagnostics 工作。

本 track 的目标是把“可跨领域复用的平台执行内核”和“AI 领域内核”正式拆开，避免后续重复搭建多套微内核。

## 要做

- 定义“平台微内核 + 领域微内核 + app overlay”三层正式架构
- 识别当前仓库中可直接复用的平台内核原语与仍属于 AI 领域的能力
- 设计新的 contract / logic / support / mod / profile 边界
- 设计增量迁移路径，使现有 AI runtime 可在不中断功能的前提下逐步切到新架构
- 将本次架构分析结论沉淀在 track 内独立文件中，作为后续实现参考基线

## 不做

- 本次不直接实施大规模代码迁移
- 本次不一次性改名或重排所有现有 package
- 本次不承诺把所有领域都抽象成完全统一的 capability taxonomy
- 本次不把 AI 领域语义错误上收为“平台内核”的一部分

## 变更内容

- 新增一份正式架构 proposal / design / spec / plan，定义：
  - 平台微内核应包含哪些能力
  - AI 领域微内核应保留哪些能力
  - `mod-platform-kernel -> mod-ai-kernel -> mod-ai-app` 的 profile 叠加方式
  - shell / runtime entry / persistence support 的消费边界

## 影响范围

- 受影响规范：
  - `vendor-actor-runtime-foundations`
  - `vendor-data-graph-stream-foundations`
  - `compose-dispatch-manifest-protocol`
  - `cell-runtime-composer-and-mod-profiles`
  - `aiagent-fiber-orchestration`
- 受影响代码范围（后续实现时）：
  - `vendor/depa-actor`
  - `vendor/depa-processor`
  - `vendor/depa-data-graph`
  - `cell/packages/core-*`
  - `cell/packages/organ-*`
  - `cell/packages/composer`
  - `cell/packages/mod-*`
  - `terminal/packages/*`
