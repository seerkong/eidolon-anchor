# 变更：引入独立 Holon task runtime contract 与 service

## 背景和动机 (Context And Why)

Eidolon 已有可恢复的 Holon deployment、TaskSpace、coordinator、MemberRuntime 与 accepted-effect journal，但产品 assignment 的 composition 目前嵌在 Workflow runtime：执行 input/profile/subscription 都携带强制 Workflow identity，且 service authority 由 Workflow 启动时注册。因此相同底层能力不能作为独立组织任务运行时复用。

本 Track 先建立中立核心。它不接产品工具与终端 bootstrap；只让 contract、Processor、service 与 focused tests 在无 Workflow 环境下闭合，为下一 Track 的入口统一提供可靠基础。

## “要做”和“不做” (Goals / Non-Goals)

目标：

- 定义 closed runtime definition/admission、Holon/member selector、task invocation/origin 与 receipts；
- 把可复用的 frozen runtime authority 与逐次 TaskSpace submission 才产生的 snapshot receipt 明确拆开；
- 定义中立 organization-task profile，并集中兼容历史 Workflow profile；
- 将执行核心从 `HolonWorkflowTaskRuntime` 提取为不需要 Workflow identity 的 Processor；
- 实现显式依赖注入的 `HolonTaskRuntimeService`，支持 admission 注册、精确解析、TaskSpace 打开、pump 与观察；
- 用无 Workflow 与 exact member 的测试锁定新能力；
- 遵守 DEPA authority、effect、processor 与 actor 边界。

非目标：

- 修改 HolonAssign/ActorAssign/MemberAssign 工具入口；
- 修改 Ctrl/Data Workflow 的产品接线；
- 扫描 workspace Halfcode resources 并自动 bootstrap file service；
- 多节点 transport 或恢复所有 process-level scheduler；
- 恢复 VM TaskTree。

## 变更内容（What Changes）

- `@cell/ai-organ-contract` 新增中立 closed data、schema 与 service/effect ports；不承载 normalizer 实现。
- `@cell/ai-organ-logic` 新增 normalizers、generic task execution Processor、target resolver 与 service logic；legacy Workflow decoder 位于独立 adapter module，canonical core 不 import Workflow contract。
- 现有 Workflow execution 保留薄 compatibility wrapper，持久数据不做破坏性重写。
- 新增 focused tests 与静态 architecture assertions。

## 影响范围（Impact）

- behaviors：`aiagent-member-holon-primary-model`、`cell-contract-logic-support-layering`。
- code：`cell/packages/ai-organ-contract`、`cell/packages/ai-organ-logic/src/organization` 及其 focused tests。
- compatibility：现有 Workflow profile/subscription/read path 必须继续通过。
