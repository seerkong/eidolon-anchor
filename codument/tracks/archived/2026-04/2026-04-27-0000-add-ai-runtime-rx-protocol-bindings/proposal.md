# 变更：建立 AI runtime 场景协议 RxData 绑定

## 背景和动机 (Context And Why)
参考项目将同一组 runtime facts 投影为多种协议输出。本项目也需要避免各入口直接拼接 eventBus、effects 和 stream adapter。通过从 public RxData 派生协议专属 RxData，可以让 TUI、terminal、web/composer、OpenAI-compatible 等入口共享事实面，同时保持用户协议解耦。

已归档的 `refactor-ai-agent-vm-runtime-shape` 和 `add-ai-agent-vm-rx-data-plane` 已经把 `AiAgentVm` 纯数据契约迁入 `ai-core-contract`，并落地了 `ensureVmRxData(vm)`、`publicRxData/privateRxData`、`publicRxBinding/privateRxBinding`、semantic event stream、history/prompt/session domain stream、usage signal 与 trace summary signal。因此本 Track 不再创建 VM 数据面，而是消费已存在的 public readonly 数据面并派生协议输出。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 定义协议 RxData / protocol frame 的基础模式，纯类型放在 contract 包，具体 binding 放在 logic 包。
- 首个可验证绑定固定为 semantic protocol frame binding：从 `AiAgentVmPublicRxData.semanticEvents`、domain streams、`usage` 与 `traceSummary` 派生协议 frame/signal。
- 约束 binding factory 必须在请求执行前调用 `ensureVmRxData(vm)`，随后只消费 public readonly 面。
- 让 usage、trace summary 等状态从 signal 投影到协议输出，不通过 semantic event 伪造状态。

**非目标:**
- 不一次性重写所有 frontend/backend 路由。
- 不实现可观测 sinks。
- 不改变 core semantic event 的业务含义。
- 不让协议层直接写入 `privateRxData` 或订阅 private stream。

## 变更内容（What Changes）
- 新增 protocol frame / protocol rx binding 类型与 factory。
- 在 `ai-organ-contract` 或相邻 contract 层定义协议 frame 纯数据类型；在 `ai-organ-logic/src/stream` 附近实现首个 semantic protocol binding。
- 首个 binding 从 `ensureVmRxData(vm).publicRxData` 派生输出数据，不直接依赖 `AgentEventGraph`、`RuntimeEffects` 或 private RxData。
- 增加绑定时序、public-only 边界、usage/signal 投影测试。

## 影响范围（Impact）
- 受影响的功能规范：AI runtime 输出协议、semantic stream adapter、message history/domain stream 派生、terminal/web/OpenAI-compatible 后续输出管线。
