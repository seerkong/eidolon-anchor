# Chat Completions Effect Bundle Design

## 上下文

OpenAI official Chat Completions 与 DeepSeek official Chat Completions 的共同机制远多于差异。公共机制包括请求发送、SSE framing、`choices[0].delta`、content/tool-call 累积、abort/timeout、ingress effects 与最终 assistant message 形状。差异集中于 endpoint、request projection、reasoning continuation 和 provider options。

当前 fetch adapter 内的 provider 猜测以模型名或 Base URL 为依据。这与 provider driver registry 已经完成的显式 adapter 选择重复，也使第三方兼容 endpoint 的语义取决于字符串偶然匹配。

## 方案概览

1. 公共函数式核心
   - 定义显式 `ChatCompletionsStreamState` 数据。
   - 以纯函数完成 content 归一化、chunk fingerprint、reasoning projection、think-tag segmentation、tool-call delta reduction 和 message finalization。
   - reducer 返回新 state 与待执行的 ingress events，不直接写 OutputStream。
   - 该核心处理 Chat Completions、tool-call 与 reasoning 领域语义，归属 `ai-organ-logic`；对应稳定类型/契约归属 `ai-organ-contract`。`symbiont-logic` 只提供通用 stream/runtime 原语，不反向依赖 AI domain 包。

2. Effect shell
   - 保留 fetch、SSE 字节读取、timeout、abort、AsyncIterable 消费和 OutputStream 发送为命令式外壳。
   - shell 只解释 reducer 产生的 effects，不拥有 provider 判断。

3. 官方 effect bundles
   - `OpenAIOfficialChatEffectBundle`：OpenAI official Chat Completions endpoint、消息投影与 reasoning 隔离。
   - `DeepSeekOfficialChatEffectBundle`：DeepSeek official endpoint、`reasoning_content` 精确保留、历史 tool-call 空字段恢复与 thinking options。
   - bundle contract 属于 AI provider contract；具体实现属于 AI provider logic。
   - bundle 暴露的 stream projection policy 是显式数据/函数契约，由公共 reducer 消费；不得在 symbiont 与 AI domain 两侧各维护一份 provider policy。

4. 显式组合
   - `OpenAIChatDriver` 组合 OpenAI official bundle。
   - `DeepSeekDriver` 组合 DeepSeek official bundle。
   - 公共 adapter 不再运行 `isDeepseekRequest(model, baseUrl)`。
   - 兼容入口未显式传 bundle 时采用 OpenAI official 默认，不根据字符串自动切换。
   - `ProviderDriverDefinition` 暴露其显式 Chat Completions bundle binding；`ProviderRuntimeLlmAdapter` 保留这个已选 driver，作为请求与 stream 投影的共同真源。
   - executor 调用 stream callback 时显式传入本次请求实际使用的 LLM adapter（或等价的强类型 binding）；terminal/shell runtime 从该 adapter 的已选 driver 取得同一个 bundle，并把它传给 ingress stream adapter。正常 provider runtime 路径不得再依据 `llmClient.type`、model、Base URL 或 adapter 字符串重新选择 bundle。
   - mock/legacy 入口若不经过 `ProviderRuntimeLlmAdapter`，必须显式注入 bundle；仅真正未提供 binding 的兼容入口允许采用 OpenAI official 默认。

5. Responses 隔离
   - OpenAI Responses API 继续使用自己的 driver、transport、continuation 与 event model。
   - 本 track 不抽象 Chat Completions 与 Responses 之间尚不稳定的共性。
   - Responses transport 当前输出的 normalized delta stream 可继续复用纯 ingress reduction mechanism，但不得调用 OpenAI Chat bundle 的 endpoint、request/history projection；其 normalized-stream policy 由 Responses driver 显式绑定并单独回归。

6. 领域迁移与兼容面
   - 将 `OpenAICompletionsNodejsFetchStreamAdapter` 及其新 reducer 从 `symbiont-logic` 迁入 `ai-organ-logic`，并更新 `IngressStreamAdapter`、对比工具和测试的工作区引用。
   - `ai-organ-logic` 保留现有公共类名和顶层导出，减少调用代码变化；不在 `symbiont-logic` 建立对 `ai-organ-logic` 的反向依赖或复制一份兼容状态机。
   - 更新 package-layout guard，使其断言 symbiont 不拥有 provider、tool-call 或 reasoning 语义。

## 影响范围与修改点（Impact）

- `cell/packages/ai-organ-contract/src/llm/`
- `cell/packages/ai-core-contract/src/`（stream callback binding，若现有强类型通道不足）
- `cell/packages/ai-core-logic/src/`（把本次请求使用的 adapter/binding 传给 callback）
- `cell/packages/ai-organ-logic/src/llm/`
- `cell/packages/ai-organ-logic/src/llm/drivers/`
- `cell/packages/ai-organ-logic/src/stream/`
- `cell/packages/symbiont-logic/src/stream/`（移除 AI-specific adapter/export，保留通用原语）
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- `cell/packages/ai-organ-logic/tests/`

## 决策摘要

- 共享核心 + 两个官方 effect bundle，禁止复制两份流状态机。
- provider driver 是 bundle 选择的唯一真源。
- 纯 reducer 与 effect interpreter 分离。
- AI provider stream 语义归 AI domain，不驻留 symbiont 平台层。
- 同一个 driver binding 显式贯穿 transport 与 ingress，不从 adapter type 二次选择。
- OpenAI Responses 保持独立。
- 详见 `decisions.xnl`。

## 风险 / 权衡

- 兼容调用方可能依赖旧 adapter 根据 URL/模型名自动识别 DeepSeek，或直接从 symbiont 深层路径导入 AI-specific stream adapter。
  - 缓解：正式 driver 显式注入；ai-organ-logic 保留旧类名/顶层导出；工作区内深层导入一次性迁移，测试要求直接调用方显式选择 DeepSeek bundle。
- 纯 reducer 提取可能改变 chunk 去重、think-tag 边界或 tool-call 拼接。
  - 缓解：先增加 characterization，逐项锁定事件序列与最终消息。
- 请求侧和流侧若各自根据字符串选择 bundle，会形成双重真源。
  - 缓解：把本次请求实际使用的 adapter/driver binding 显式传给 stream callback，并增加 child actor、mock 与第三方 Base URL 的端到端测试。
- effect bundle 可能膨胀为任意 hook 集合。
  - 缓解：只承载 endpoint、request/history projection 与 provider stream reasoning policy；公共机制保持在 core。
- `reasoning_details` 与 `<think>` 属于兼容扩展而非 OpenAI 官方字段。
  - 缓解：作为明确的 stream projection policy 保留，不宣称为 OpenAI 官方 contract。

## 兼容性设计

- DeepSeek 的 `reasoning_content` 空值、镜像值和 tool-call continuation 行为保持不变。
- 普通 OpenAI Chat 请求不注入 DeepSeek compatibility 字段。
- 历史 session 不迁移，在 DeepSeek bundle 的请求边界恢复。
- 现有公共类名在 ai-organ-logic 内保留；symbiont 深层导入属于内部领域迁移，不承诺兼容。
- 使用第三方 DeepSeek-compatible endpoint 的配置应通过 `adapter: deepseek` 显式选择 DeepSeek bundle。

## 迁移计划

1. 先用测试冻结当前公共流行为和 provider 隔离行为。
2. 在 AI domain 提取纯 reducer，并迁移原 stream adapter 类名与工作区调用方。
3. 引入 contract、两个 bundle 与公共 transport 组合。
4. 驱动层改为显式注入，将同一 binding 传到 stream callback/ingress，并删除请求侧和流侧启发式。
5. 保持 Responses normalized stream 的独立显式 binding。
6. 跑 focused、provider runtime、terminal binding 与 package-boundary 回归，检查无 session 数据变更。

## 待解决问题

- 无阻塞问题。第三方兼容 provider 的新 dialect 不在本 track 内自动推断，后续按显式 bundle 扩展。
