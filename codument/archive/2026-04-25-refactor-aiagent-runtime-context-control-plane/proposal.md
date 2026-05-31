# 变更：重构 AIAgent Runtime Context Control Plane

## 背景和动机 (Context And Why)
当前本项目已经完成 `.eidolon` conversation domain persistence 的主链落地，但对“大模型执行上下文控制”这件事，仍缺少正式、联动的数据驱动控制面。现状更偏向局部 prompt 组装与局部 runtime 逻辑，还没有把 `work_mode`、`task_phase`、动态 prompt assemble、phase-aware compaction、continuation baseline 等机制收口成统一主链。

本次 track 的目标，是把参考项目中用于控制 LLM 执行上下文的关键机制，迁移为本项目的标准实现方式，并对齐本项目既有的 `vendor/depa-data-graph`、`vendor/depa-actor`、signal + stream、以及 `cell/packages/ai-support` 的 `.eidolon` 副作用分层。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 在本项目中建立正式的 runtime context control plane，统一承接 `work_mode`、`task_phase`、source 与 timestamps。
- 让 turn start、tool round、prompt assembly、compaction、continuation reset 共同消费同一份 work context。
- 将 prompt 装配升级为 plan/generation/transform 驱动，而不是局部字符串拼接。
- 让 compaction policy 显式受 `work_mode` / `task_phase` 影响，并在 rewrite 后正式推进 baseline epoch / continuation reset。
- 继续走 runtime-first、persistence-fallback 路径，使 TUI、headless、runtime bridge 能消费这套控制面。
- 将新增 `.eidolon` 本地副作用实现放入 `cell/packages/ai-support`。

**非目标:**
- 不逐字照搬参考项目的 prompt 文本、Python 实现细节或所有扩展注册形式。
- 不要求本 track 首期完成参考项目全部 skill/subagent/overlay 生态。
- 不把 provider-specific 诊断细节、所有 inspection guard 提醒 surface 一次性做到最细。
- 不回退已有 conversation domain persistence 主链，也不把本次设计降级成只针对 TUI 的局部方案。

## 变更内容（What Changes）
- 新增正式的 runtime `work_context` 数据模型与状态推进规则。
- 新增 `PromptPlan` / `PromptGeneration` / `PromptTransform` 的迁移与本项目落地方案。
- 新增 phase-aware compaction policy / decision 建模，并打通与 continuation baseline 的联动。
- 把 prompt request、overlay、summary/context 等 prompt truth 变化纳入正式 conversation domain 主链。
- 扩展 runtime-first consumption，使上层消费面可读取正式 work context、prompt truth 与 compaction state。
- 在 `ai-support` 中补充必要的 `.eidolon` 本地副作用持久化与 artifact 落盘支持。

## 影响范围（Impact）
- 受影响的功能规范：
  - `aiagent-persistence-recovery`
  - `aiagent-reference-aligned-stage-streaming`
  - `terminal-tui-shell`
  - `shell-runtime-facade-ports`
  - `vendor-actor-runtime-foundations`
  - `vendor-data-graph-stream-foundations`
- 受影响的代码方向：
  - aiagent conversation/runtime domain
  - prompt assembly / runtime bridge
  - compaction / continuation handling
  - `.eidolon` local support backend in `cell/packages/ai-support`
