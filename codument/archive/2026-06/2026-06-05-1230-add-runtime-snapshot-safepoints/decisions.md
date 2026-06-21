# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】非 Safepoint 快照处理策略
- 背景：保存快照时可能发现当前 runtime 尚未到达可恢复 safepoint。
- 需要决定：非 safepoint 时的默认策略。
- 选项：
  - A) 受限推进到 safepoint；无法推进时跳过保存并保留 previous known-good snapshot
  - B) 直接失败并阻断当前 turn
  - C) 只记录诊断但仍保存
- 当前建议：A
- 用户答复：用户要求每次保存都应当是可恢复 safepoint；不接受把半步状态落盘。
- 最终决策：A
- 决策理由：A 满足 crash consistency，同时避免因为短暂半步状态阻断交互；C 违反 safepoint 语义，B 对 TUI 体验风险较高。
- 状态：accepted

### 2. 【P0】`start_tool` 的调度语义
- 背景：`start_tool` 位于 assistant tool call 写入 history 和 durable tool operation 创建之间。
- 需要决定：是否把 `start_tool` 当作恢复时补 wake 的特殊 case，还是保存前必须消费的 mandatory continuation。
- 选项：
  - A) 保存前必须消费到 durable operation 或 typed wait
  - B) 允许保存，恢复时补一次 wake
  - C) 允许保存，由 transcript-tail repair 推断
- 当前建议：A
- 用户答复：用户明确要求从根因修复，不通过补唤醒修修补补。
- 最终决策：A
- 决策理由：A 防止产生新的坏快照；B/C 只是恢复期补救，不能保证保存完成即为 crash-safe。
- 状态：accepted

### 3. 【P1】相关未提交变更纳入范围
- 背景：当前工作树已有未提交变更，部分与 tool-call 协议一致性相关。
- 需要决定：哪些未提交变更纳入本 track。
- 选项：
  - A) 仅纳入 OpenAI Responses tool-call/tool-output 配对相关变更
  - B) 纳入所有未提交变更
  - C) 不纳入任何已有未提交变更
- 当前建议：A
- 用户答复：用户要求前面已做且相关的未提交部分放入新 track。
- 最终决策：A
- 决策理由：OpenAI Responses 配对修复与 provider tool-call 协议一致性直接相关；delegate/member/batch 变更属于工具语义和工具集调整，和 safepoint 机制不是同一变更面。
- 状态：accepted

### 4. 【P0】Safepoint 推进职责边界
- 背景：初版实现让 `saveAiAgentRuntimeSnapshot()` 在非 safepoint 时调用 foreground settle，导致 persistence writer 隐含调度副作用。
- 需要决定：保存前推进到 safepoint 的职责应放在哪里。
- 选项：
  - A) Runtime coordinator / orchestrator 显式推进，snapshot writer 只判定和落盘
  - B) Snapshot writer 内部继续推进
  - C) 恢复时补 wake，保存时不处理
- 当前建议：A
- 用户答复：用户要求根据 project attractor 分析结果改进实现。
- 最终决策：A
- 决策理由：A 更符合 DEPA、Data/Effect 分离、内聚边界和 explicit runtime；B 让 persistence 混入调度副作用，C 不是根因修复。
- 状态：accepted

### 5. 【P0】Snapshot 保存结果与诊断建模
- 背景：初版保存函数在非 safepoint 时静默返回，并把 diagnostic 临时挂在 runtimeContext 的 `any` 字段上。
- 需要决定：保存跳过与诊断如何暴露。
- 选项：
  - A) 保存函数返回结构化结果，并通过返回值暴露 bounded safepoint blocker；不扩展 `AiAgentVm` / `VmRuntimeContext`
  - B) 继续返回 void 并仅写临时 diagnostic
  - C) 非 safepoint 时抛错
- 当前建议：A
- 用户答复：用户要求将不符合 attractor 的改进措施纳入并实现；后续明确要求撤回 `AiAgentVm` 改动后继续修复。
- 最终决策：A
- 决策理由：A 符合 minimize-surprise、data-oriented-programming 和 observability-before-speculation；同时避免把 AI runtime 内部诊断细节下沉到核心 VM 契约。C 会破坏交互流，B 不可观测且语义含混。
- 状态：accepted

### 6. 【P0】Conversation 文件持久化的 Safepoint 边界
- 背景：问题现场显示 runtime snapshot 已停在较早 safepoint，但 conversation history/transcript 已推进到之后的工具循环尾部；恢复时优先加载 conversation runtime messages，导致旧 runtime 与新 conversation tail 拼接。
- 需要决定：conversation history 是否可以在 runtime 未到 safepoint 时即时写入并成为恢复真相源。
- 选项：
  - A) Conversation domain 先在 VM 内存缓冲，只有 runtime 到达 safepoint 后由 snapshot save 统一 flush 到文件
  - B) 继续 append 时即时写 conversation 文件，恢复时用 watermark 裁剪
  - C) 继续即时写，恢复时由模型自行处理 tail
- 当前建议：A
- 用户答复：用户要求 conversation 也由相同 safepoint 一同管理；没到 safepoint 的消息先加入内存缓冲，到 safepoint 再写入。
- 最终决策：A
- 决策理由：A 让 runtime snapshot、conversation head、session index 共享同一 crash-consistency 边界；B 仍会产生已落盘但未被 safepoint 承认的 tail，C 违反恢复确定性。
- 状态：accepted

### 7. 【P0】Durable mailbox redelivery 去重
- 背景：现场中 `humanInput` 已进入 conversation/memory，但 actor mailbox 仍存在同一 payload，恢复后可能再次投递。
- 需要决定：恢复 pending durable control signal 时如何处理 mailbox 已包含相同 payload 的情况。
- 选项：
  - A) 只在 mailbox 缺少 payload 时投递；无论是否投递都消费 durable signal 并记录 recovered delivery
  - B) 总是重新投递
  - C) mailbox 已有 payload 时保留 durable signal 未消费
- 当前建议：A
- 用户答复：用户要求修复 `humanInput 已进入 conversation，但 mailbox 里仍有同一条输入` 的问题。
- 最终决策：A
- 决策理由：A 保持恢复幂等，避免重复输入；C 会让同一 signal 后续反复参与恢复。
- 状态：accepted

### 8. 【P0】Wake mailbox pending work 的 Safepoint 分类
- 背景：历史现场再次停在 `ready + wait_llm + asyncCompletion`，说明 LLM 已完成并写入 mailbox，但 `agent_step` 尚未消费该结果；这和 `start_tool` 半步同属 mandatory continuation。
- 需要决定：safepoint 是否只覆盖具体 phase，还是统一分类 actor wake mailbox 中的 pending work。
- 选项：
  - A) 统一分类 wake mailbox；仅把匹配当前 inflight/同步等待的 completion 类 pending work 视为非 safepoint，由 coordinator 保存前推进
  - B) 继续只针对 `start_tool` 和少数已知 phase 特判
  - C) 允许保存，恢复时补 wake 或等待下次用户输入触发
- 当前建议：A
- 用户答复：用户要求查看 mailbox 的所有类型，一次性考虑全面，而不是每次修一点；同时要求避免不必要扩展 `AiAgentVm`。
- 最终决策：A
- 决策理由：A 符合 actor mailbox communication 和 crash consistency，同时保留普通外部输入 mailbox 的可恢复语义；B 会继续遗漏半步；C 是恢复期补救。实现上 mailbox 类型只保留在 AI runtime 内部 safepoint result，不扩展 `AiAgentVm` 字段。
- 状态：accepted

### 9. 【P1】Safepoint 逻辑的原语化预备边界
- 背景：safepoint、heartbeat、actor surface、questionnaire/TUI 控制面和 mailbox wake 调度都在推动同一类 actor 控制面一致性原语化。用户指定后续底层 vendor 包倾向为 `depa-actor-control`，AI 领域包倾向为 `cell/packages/ai-runtime-control-contract` 与 `cell/packages/ai-runtime-control-logic`。
- 需要决定：当前 track 是否直接创建新包，还是先做小幅边界整理。
- 选项：
  - A) 当前 track 只把 safepoint 判定和 mailbox 分类从 persistence writer 移到 runtime 控制面 helper，作为后续原语化迁移前置
  - B) 当前 track 直接创建 `ai-runtime-control-*` 包并迁移相关调用
  - C) 当前 track 直接创建 `depa-actor-control`
- 当前建议：A
- 用户答复：用户要求先分析当前 track 在已开发完状态下做怎样的较小调整，便于后续原语化改造。
- 最终决策：A
- 决策理由：A 能降低当前 track 风险并修正职责边界；B/C 会把 safepoint 修复扩大为架构迁移，容易过早固化尚未验证的 vendor 原语。
- 状态：accepted
