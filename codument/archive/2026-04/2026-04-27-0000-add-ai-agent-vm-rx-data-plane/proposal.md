# 变更：为 AiAgentVm 建立 public/private 响应式数据面

## 背景和动机 (Context And Why)
参考项目证明了 runtime public/private rx data 对多协议 adapter 和 observability 很有价值。本项目已经有更通用的 `vendor/depa-data-graph`，因此应使用其 stream、timeline、projection、signal 能力建立 TypeScript 原生的数据面，而不是引入 Sparrow 的 Python 响应式依赖。

第一 Track 额外完成了更关键的建模调整：`AiAgentVm` 与 registry/snapshot/runtime ctx 等纯契约已迁入 `ai-core-contract`，`ai-core-logic` 只保留具体 registry 逻辑、`createVM` 和 ensure helpers。因此本 Track 需要从“新增字段”调整为“填充 contract 中已存在的 rx seam，并在 logic 包实现具体数据面”。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 定义 `AiAgentVmPrivateRxData` 与 `AiAgentVmPublicRxData`。
- 在 `AiAgentVm` 上挂载 `privateRxData`、`publicRxData` 与生命周期 binding。
- 替换 `ai-core-contract/src/runtime/AiAgentVm.ts` 中当前 `null` RxData 占位类型。
- 保持 contract/logic 分层：contract 定义协议，logic 使用 depa-data-graph 实现。
- 将 semantic events、conversation history/prompt/session domain events 暴露为 stream。
- 将 usage、busy 或 trace summary 这类状态作为 signal/projection 暴露。
- 保证 public 读面不能直接写 private 数据。

**非目标:**
- 不实现具体 Web/OpenAI/TUI 协议输出。
- 不实现可观测 sinks。
- 不迁移全部历史状态到 RxData。

## 变更内容（What Changes）
- 新增 AI runtime rx data 类型与 runtime ops。
- 在 contract 层定义不依赖 depa-data-graph class 的 stream/signal reader/writer 协议。
- 在 logic 层使用 `depa-data-graph` 的 timeline/log/signal/projection 作为基础。
- 增加生命周期 binding，core 侧接入 `AgentEventGraph`，organ 侧通过可选 binding 接入 conversation domain runtime。

## 影响范围（Impact）
- 受影响的功能规范：AI runtime 数据面、`ai-core-contract` / `ai-core-logic` 分层契约、扩展消费入口、后续协议 adapter 与 observability。
