# Mission：隔离 Workflow 生命周期并控制 Provider 缓存成本

## 背景

近期 DeepSeek 缓存命中率下降的排查暴露了两个相互关联、但不能用一个 Track 粗暴修补的问题。

第一，Workflow 原本应当是 Eidolon 中一种专用的产品能力，但其 lifecycle 概念已经进入通用 Actor 路径：Workflow 内部工具进入全局 builtin tool catalog，`tools: "*"` 可能获得 Workflow 内部工具；通用 executor/core snapshot 又直接认识 Workflow progress。这样，即使用户没有使用 AI Workflow，通用运行时也被迫携带 planning、coding、testing、releasing 等概念。

第二，过去为了表示 Workflow stage，系统会替换前部 system prompt 和 provider tool schema；最近的修复虽已把一部分 stage fact 改为 append-only，并加入 DeepSeek cache usage 采集，但仍存在动态 progress system prompt、late work-context overlay、live system Skill reread、provider surface 过大等潜在缓存失效或 token 膨胀点。单个局部测试全绿，不能证明完整 Workflow 产品旅程的总成本没有显著上涨。

这是一个需要持续观测、分阶段改造、fresh 验证和反复纠偏的控制目标，因此必须由 Mission 统筹多个有依赖关系的 Tracks，而不是继续扩大某个 Track。

## 目标

- 只有专用 Workflow 生命周期 Actor 才拥有 planning、coding、testing、releasing 等 lifecycle authority。
- 普通 primary/Code Actor 与 AI Ctrl/Data Workflow 的节点 Agent 都是 stage-free；节点只接收 run/node/generation/task/claim/attempt 等自身执行事实。
- Workflow 内部工具、progress profile 与 DevOps system Skill 进入专用 capability/resource capsule；普通 Actor 只看到显式公开 Workflow gateway。
- 通用 Actor executor/core 只依赖中性的 lifecycle/policy extension port，不直接依赖 Workflow 类型或状态。
- 同一 provider context epoch 内，前一请求的可缓存前缀在后一 forward-only 请求中保持逐项、顺序和字节稳定。
- 对 compaction、rewind、provider/model switch、显式资源 revision 变更等真实边界建立可观察的 context epoch，不用隐藏或伪造 cache hit。
- 将 DeepSeek structural prefix coverage、provider-reported hit/miss 和归一化 provider token 成本都升级为产品验收指标。
- Workflow actor 同样满足缓存和成本预算；不能因启用 AI Workflow 而出现无解释的持续 cache miss 或大幅 token 膨胀。

## 非目标

- 不把 AI Workflow 节点 Agent 变成 Workflow DevOps lifecycle Actor。
- 不让模型输出或 system prompt 成为 lifecycle、stage 或 cache epoch 的事实 authority。
- 不新建第二套 Conversation/History/Session/compaction authority。
- 不通过删除工具执行授权、丢弃 reasoning/tool pair 或缩减 canonical history 来换取缓存命中。
- 不把官方 DeepSeek 的 cache usage contract 等同于 SiliconFlow 等兼容 provider；二者分别验证。
- Mission 文件不直接实现代码。任何代码、测试、行为和发布变更必须由绑定的 Track 完成。

## 成功判据

1. 非 Workflow 产品路径的最终 provider request 不包含 Workflow stage、内部 Workflow tools、Workflow progress overlay 或 DevOps Skill 内容，且不支付 Workflow-only token/schema 成本。
2. AI Workflow 节点 Agent 的 provider context 只包含其冻结任务/节点/Agent execution authority，不自动获得 Workflow lifecycle stage。
3. 专用 Workflow lifecycle Actor 能完成真实 authoring/implementation/testing/releasing 旅程；其 lifecycle profile 由专用 capsule 持久和恢复。
4. 同一 epoch 的连续完整最终 HTTP request body 具有 100% 的 retained-prefix 结构稳定性；每一次非延伸变化都有显式、持久、可恢复的 epoch reason。
5. 官方 DeepSeek 的 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens` 与总 prompt token 在最终成功 attempt 上被准确采集；兼容 provider 使用独立 capability/expectation。
6. 基线 Track 形成并批准 normalized-cost budget；最终普通和 Workflow E2E 均满足预算。命中率不得以增加大量稳定但无用的工具 schema 来“优化”。
7. 503 retry、tool call/result、reasoning、pending delivery、fresh recovery、compaction、rewind、provider/model switch、多 Actor/长上下文均有最终-wire 证据。
8. 每个实现 Track 后运行 fresh coding AttractorCheck；发现 P0/P1 或成本偏差就 replan/gap-loop，直至 Mission 独立验证无 P0/P1。

## 既有工作的定位

- 已完成 Mission `enforce-provider-context-architecture` 是 canonical history/provider projection 的前置基础，不重新打开其历史 DONE。
- 已完成 Track `restore-deepseek-prefix-cache-stability` 和 `add-provider-epoch-and-deepseek-conversation-projection` 作为现状基线和回归证据，不等同于本 Mission 的最终验收。
- 本 Mission 新建的 Track 必须在现有单一 Conversation authority、provider projection gate 和 context epoch 基础上演进，不复制这些机制。
