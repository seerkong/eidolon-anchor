# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由

### 1. 【P0】RxData 类型所在包
- 背景：RxData 既是 AI 领域契约，又依赖 depa-data-graph 能力。
- 需要决定：类型放在哪里。
- 选项：
  - A) `cell/packages/ai-core-contract` 定义契约，`ai-core-logic` 实现 binding
  - B) 全部放在 `ai-core-logic`
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：第一 Track 已将 `AiAgentVm` 契约迁入 `ai-core-contract`，logic 包承载实现。
- 最终决策：采用 A；`ai-core-contract` 定义 RxData 协议，`ai-core-logic` 实现 depa-data-graph backed binding。
- 决策理由：延续第一 Track 的 contract/logic 分层，避免 contract 依赖具体运行时实现。
- 状态：accepted

### 2. 【P0】binding 字段命名
- 背景：用户草案中有 `publicRxBinding`、`privateRxDBinding`，后者可能是拼写误差。
- 需要决定：最终字段名。
- 选项：
  - A) `publicRxBinding` 与 `privateRxBinding`
  - B) 单字段 `rxBinding`
  - C) 保持草案拼写 `privateRxDBinding`
- 当前建议：A，避免拼写遗留并表达读写面分离
- 用户答复：第一 Track 已确认 `privateRxDBinding` 是拼写问题，规范为 `privateRxBinding`。
- 最终决策：采用 A，字段名为 `publicRxBinding` 与 `privateRxBinding`。
- 决策理由：与已完成 VM 字段规范保持一致。
- 状态：accepted

### 3. 【P1】首批 signal 范围
- 背景：usage/busy/trace summary 都适合 signal，但第一阶段不宜过大。
- 需要决定：首批 signal。
- 选项：
  - A) 先做 `usage`，预留 `busy` 和 `traceSummary`
  - B) 同时做 `usage`、`busy`、`traceSummary`
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：
- 最终决策：
- 决策理由：
- 状态：pending

### 4. 【P0】contract 是否允许依赖 depa-data-graph 实现类
- 背景：第一 Track 已把 `AiAgentVm` 纯契约迁入 `ai-core-contract`，而 `@depa-data-graph/core` 是运行时实现基础。
- 需要决定：contract 类型是否直接引用 depa-data-graph classes。
- 选项：
  - A) 不允许；contract 只定义最小 stream/signal 协议，logic 使用 depa-data-graph 实现
  - B) 允许 contract 直接 import depa-data-graph 类型
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：
- 最终决策：A
- 决策理由：保持 `ai-core-contract` 不依赖具体 runtime 实现，符合第一 Track 的分层调整。
- 状态：accepted

### 5. 【P1】conversation domain stream 绑定所在层
- 背景：conversation domain runtime 位于 `ai-organ-logic`，而 core RxData 初始化位于 `ai-core-logic`。
- 需要决定：history/prompt/session domain streams 由谁接入。
- 选项：
  - A) core 提供 optional binding seam，organ 层负责把 conversation domain runtime 接入 private rx data
  - B) ai-core-logic 直接 import ai-organ-logic 并绑定
  - C) 本 Track 暂不涉及 conversation domain streams
- 当前建议：A
- 用户答复：
- 最终决策：A
- 决策理由：尊重双层微内核边界，避免内层 core 反向依赖外层 organ。
- 状态：accepted
