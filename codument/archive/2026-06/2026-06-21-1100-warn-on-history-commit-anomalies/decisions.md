# Decisions

## Usage
- 记录需用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行中出现的新决策继续追加到本文件

### 1. 【P0】告警外溢通道
- 背景：reducer 是纯函数，不能在其中 `console.warn`。告警必须经事件/可观测通道外溢由宿主记录。
- 需要决定：用什么通道把异常告警从 MessageHistoryGraph 送到可观测处。
- 选项：
  - A) 新增一类结构化 anomaly/warning 事件，经既有 listener 通道外溢，宿主侧 `console.warn` + 可选诊断记录（与 `emit`/`emitCommitted` 同构，reducer 保持纯）
  - B) 复用既有 diagnostics/observability sink 直接记录
  - C) 其他
- 当前建议：A（最贴合既有事件驱动架构、reducer 纯、宿主集中记录、易 grep）
- 最终决策：A（安全默认，非阻塞）
- 决策理由：保持唯一水源与纯 reducer 不被破坏；告警走与提交同构的事件通道，宿主统一落日志/诊断。
- 状态：resolved（安全默认，实现期可微调宿主记录细节）

### 2. 【P0】告警是 warning 非异常，且不改提交内容
- 背景：用户明确"产生 warning、快速定位",不是抛错。
- 决定：异常交互**只新增告警**，**不改变实际被提交的消息**（孤儿 tool 消息仍按现状提交、空壳仍按现状提交），**不抛错**、不中断 turn。
- 最终决策：观测-only；warn + continue；保留唯一水源、不加兜底写者。
- 决策理由：单写者/唯一水源是核心设计，加兜底写者会掩盖故障、积技术债；正确加固是"失败即出声"。
- 状态：resolved

### 3. 【P1】孤儿判定的配对来源
- 背景：判断一个 tool result 是否"孤儿",需要已知该 turn/generation 见过哪些 assistant 工具调用 id。
- 决定：reducer 内维护"已见 tool_call_id 集合"（来自 `semantic_tool_call_start/_planned` + pending/已提交 assistant 的 toolCalls）；result 的 id 不在集合内 → 孤儿。
- 最终决策：reducer 内已见-id 集合判定。
- 决策理由：纯 reducer 可携带该集合作为投影状态，无需外部查询。
- 状态：resolved
