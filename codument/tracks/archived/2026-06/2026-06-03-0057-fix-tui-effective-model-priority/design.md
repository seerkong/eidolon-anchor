# 设计：TUI Effective Model Source Priority

## 目标
把 TUI 中“当前使用哪个模型”从一个拍平的 selection 字段，改为由多个带来源的候选值解析出的 effective model。这样 UI、启动参数、agent 默认和 runtime 历史都能共存，同时不会互相覆盖。

## 数据模型
新增或等价表达以下概念：

```ts
type TuiModelSource =
  | "user-explicit"
  | "cli-arg"
  | "agent-memory"
  | "agent-default"
  | "runtime-config"
  | "recent"
  | "provider-default"

interface TuiModelCandidate {
  source: TuiModelSource
  providerID: string
  modelID: string
}

interface TuiEffectiveModel {
  source: TuiModelSource
  providerID: string
  modelID: string
}
```

`TuiA1Selection` 可以继续承载当前 agent identity，但 provider/model 不应再作为没有来源的唯一真相。若保留兼容字段，也应由 effective model 投影生成，而不是反向驱动所有来源。

## 优先级
有效模型按以下顺序解析：

1. `user-explicit`：TUI 模型 dialog 中人工选择。
2. `cli-arg`：启动时显式指定的 `--model provider/model`。
3. `agent-memory`：当前 agent 的用户记忆或 per-agent override。
4. `agent-default`：agent definition 声明的默认模型。
5. `runtime-config`：runtime/preset/config 默认模型。
6. `recent`：最近使用模型。
7. `provider-default`：provider 默认或可用列表中的第一个模型。

## 投影规则
- 模型 dialog 选择只写入 `user-explicit` 来源。
- 启动参数只写入 `cli-arg` 来源，不应伪装成人工选择。
- agent 切换时重新收集 `agent-memory` 和 `agent-default` 候选，并重新计算 effective model。
- runtime 历史消息推断出的模型只允许作为低优先级候选或恢复辅助，不允许覆盖更高优先级来源。
- provider/model-only 变化不得触发“agent 已变化”的效果，避免 agent 默认模型同步循环覆盖人工选择。

## Runtime 边界
effective model resolver 只负责算出 UI 当前选择，不是 runtime 事实源。最终生效的 actor 模型配置必须通过 cell VM/actor 边界写入：

1. TUI 将 effective model 作为“设置 actor active model”的意图提交给 runtime bridge。
2. Terminal bridge 根据 provider catalog/preset 解析完整 `ActorModelConfig`。
3. Bridge 通过 `driver.emitFiberSignal(... mailbox: control)` 向目标 actor 投递 `set_active_model_config`。
4. cell 层从 actor `control` mailbox 应用该配置到 `actor.modelConfig`。
5. provider 请求和 snapshot 均读取 actor 自身的 `modelConfig`。

禁止通过 `turn({ model })` 这类 terminal-only 参数直接改变单次 LLM 请求。否则 UI 和 VM/actor 会形成双真相源，恢复 session 或切换 actor 时会再次失效。

显式模型选择必须使用严格解析：`providerID/modelID` 必须命中 provider catalog 中的 provider 和 model。若 provider/model 不存在，runtime bridge 返回可见的 Runtime error，TUI 保留用户输入和错误消息；不得把解析失败包装成 fallback modelConfig 写入 actor，否则 UI 会显示已切换但 LLM 请求仍使用旧 provider。

`ActorModelConfig` 必须承载完整 provider/model 运行参数，而不仅是 provider/model/apiKey/baseUrl。`llm-provider.json` 中 provider-level options 和 model-level options 合并后写入 `ActorModelConfig.options`，adapter 初始化和 actor active model 切换时都从 actor 的 `modelConfig` 传入 `model/options`。否则类似 `fhl_mom/gpt-5.5` 的 `serviceTier`、`store`、`reasoningEffort` 会在 runtime 边界丢失，形成“状态条显示正确但 provider 请求不可用”的双真相问题。

Responses adapter 发送 tool schema 前必须执行 OpenAI-compatible schema 正规化，至少剥离 `anyOf`、`oneOf`、`allOf`、`not`。本次现场中 `fhl_mom/gpt-5.5` 的无工具请求可正常返回，但完整 coding 请求因为 `apply_patch` 顶层 `anyOf` 触发 `response.failed`，表现为“模型已切换但对话无输出”。`response.failed` 也必须作为 provider 错误显式抛出，不能静默完成为空输出。

## UI 展示
composer/input 底部状态条展示 effective model 的 `providerID/modelID`。如果需要调试，可在开发输出或测试中断言 source；常规 UI 不强制展示 source，避免增加视觉噪音。

## 测试策略
- 单测覆盖 resolver 优先级。
- graph 投影测试覆盖 runtime 历史不覆盖人工选择。
- TUI local context 测试覆盖模型 dialog 选择后状态条显示更新。
- agent 切换测试覆盖 agent identity 变化会重算，但 provider/model-only 变化不会触发默认模型覆盖。

## 风险
- 若实现继续同时维护拍平 selection 和 source-aware state，可能产生双真相源。实现时应让 effective model 成为展示和提交链路的统一输入。
- 旧测试可能断言 selection 被 runtime history 自动改写，需要更新为 source-aware 语义。
