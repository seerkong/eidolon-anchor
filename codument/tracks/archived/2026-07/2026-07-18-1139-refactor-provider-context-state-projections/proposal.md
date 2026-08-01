# 变更：Provider Context 动态状态投影

## 背景和动机 (Context And Why)

当前 provider prompt 虽然会把 work-context overlay 放在最后一个 user 之前，但 TaskTree 等可变状态仍通过普通 assistant/tool 历史持续追加。真实 session 因此在最近上下文中积累多个完整任务列表和重复资源调用，形成强烈的尾部重复信号。History 必须保留完整审计事实，但 provider view 不应把已经由当前状态投影承接的旧工具配对永久重放。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 建立工具无关的 mutable provider projection fact 和 tool context-effect 协议。
- 新工具配对成功交付 provider 一次后，在后续 provider view 中按 `tool_call_id` 整体消隐 call/result。
- 按 projection key/revision 只投影一个当前动态状态，并放在 cache-friendly late insertion boundary。
- 保持 History、ToolCallDomain、runtime effects 和恢复审计完整。
- 让 streaming 与 cooperative 两条执行路径采用同一生命周期逻辑。
- 让恢复后的 shell control actor 使用当前 profile-owned system prompt，同时保留 actor/session 状态与用户自定义 prompt。
- 以当前源码恢复真实问题 session 并完成 mission 归档；若仍重复，则保存证据并给出根因与改造建议。

**非目标:**
- 不删除或重写 History 记录。
- 不为 TaskTree、Skill 或 Read 在 materializer 中添加工具名判断。
- 不实现循环检测、无进展判断、调用次数限制或模型纠偏。
- 不改变已完成的 versioned text-resource revision/visibility 机制。
- 不把产品提示词语义移入 terminal。
- 不对来源不明确的多条 legacy system prompts 做猜测性覆盖。
- 不把真实 session 的成功作为替代单元测试和恢复契约测试的唯一验收。

## 变更内容（What Changes）
- 增加通用 tool execution context-effect envelope 和 mutable projection fact contract。
- 扩展 Conversation Session context owner，持久化 projection key、revision、content、placement、source tool calls 和 delivery 状态。
- 在 provider materialization 中按 tool-call group 过滤已成功交付且已投影的 source pair。
- 将当前 projection 以稳定顺序插入最后一个 user 前，不进入 stable provider prefix。
- 在 provider 成功完成后确认本次 request 中 projection source pair 的 first delivery。
- 让 TaskTree producer 返回 compact acknowledgement，并发布当前 task-tree projection。
- 增加 materialization、首次交付、revision replacement、恢复和双执行路径测试。
- 为 shell control actor 增加 profile-owned prompt slot/provenance，并在恢复时由 bootstrap 用当前 profile assembly 精确协调该 slot。
- 对 legacy snapshot 只迁移空 prompt 或单 prompt；多 prompt 且无 provenance 时保持原样并记录诊断。
- 通过 CLI `cwd + session` 精确恢复真实 session，记录归档结果或重复行为的新证据。

## 影响范围（Impact）
- 受影响的能力（behaviors）：`ai-semantic-conversation-spine`
- 受影响的代码：AI core tool contract、Conversation context contract/runtime/materializer、executor shared leaves、TaskTreeWrite producer、actor snapshot prompt provenance、shell recovery bootstrap、CLI recovery tests and focused live verification
