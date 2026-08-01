# 变更：统一渐进式上下文资源加载

## 背景和动机 (Context And Why)

真实 session 中，模型多次调用 `Skill(codument-archive-mission)` 并重复读取相同文本，却没有继续执行任务。当前 Skill 提示词施加无幂等条件的持续义务，运行时又没有统一表达“某个文本资源的哪个 revision、哪个片段已经交付且仍对 provider 可见”。如果只为 Skill 增加 loaded 状态，会继续扩大 Skill 特例，并阻碍后续移除 Skill 专用处理。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 建立工具无关的文本资源身份、content revision、片段覆盖和 delivery 事实。
- 复用现有 Conversation/Session context asset 与 LLM Context 所有权，不创建 Skill-loaded 平行真源。
- 让普通 `read` 与 Skill 解析后的本地文档使用同一渐进加载机制。
- 在相同 revision 和范围仍可见时复用，在内容变化或 delivery 被压缩/移除时重新交付。
- 移除 terminal 对 Skill 产品语义的提示词注入，由内核和实时工具 schema 各自拥有其语义。

**非目标:**

- 不实现通用无进展检测、循环纠偏、重复次数限制或迭代上限。
- 不在首期实现 URL、webfetch、MCP resource 的 revision validator。
- 不在本 track 完全删除 Skill 工具或 Skill catalog。
- 不改变 ToolCallDomain 的工具生命周期所有权。

## 变更内容（What Changes）

- 扩展 context asset 数据，使其可表达规范 resource id、content digest revision、行片段和 tool-result delivery 引用。
- 增加纯函数式 revision、fragment coverage、provider visibility 和 reload-decision 逻辑。
- 增加本地文本 resource loader，统一读取、摘要、范围选择和资源事实写入。
- 将 `read` 与 `Skill` 接到统一 loader；Skill 只保留名称到本地文档的解析职责。
- 将提示词义务改为通用资源复用/重载规则，并移除 terminal 的 Skill 描述注入。
- 增加持久恢复、内容变化、范围覆盖和压缩失效的聚焦回归测试。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`progressive-context-resource-loading`
- 受影响的代码：Conversation contract/capsule、local text tools、Skill catalog、kernel prompt/tool schema、terminal runtime composition、snapshot/recovery tests
