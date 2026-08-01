## 上下文

`read` 与 `Skill` 当前都返回普通字符串。History 记录工具结果，ToolCallDomain 记录工具生命周期，Session context asset 已能表示 workspace/MCP 等上下文来源，LLM Context 则决定 provider 实际看到什么。缺失的是贯穿这些现有 owner 的资源身份与 delivery 关联。

## 方案概览

1. 资源事实模型
   - context asset 增加 canonical resource id 与 content-addressed revision。
   - revision 使用完整源文本 SHA-256；mtime/size 只能用于快速探测，不能作为相等性的最终依据。
   - fragment 首期使用闭区间行范围，并记录该片段的 content digest。
   - delivery 记录 toolCallId、revision digest、fragment id 和交付时间，不复制完整文本。
2. 可见性与决策
   - 从 Conversation materialization 取得当前 provider context。
   - 通过 delivery toolCallId 定位 tool result；完整结果才贡献 visible coverage。
   - `<compacted-tool-result status="delivered_and_compacted">` 与 `<persisted-tool-result status="delivered_and_compacted">` 不贡献 coverage，即使 preview 包含原始文本。
   - 同 revision 下，requested range 被 visible coverage 完全覆盖时返回通用 `already-visible` 结果；否则只交付尚缺范围。
   - revision 改变时，旧 fragment/delivery 保留审计但不参与新 revision coverage。
3. 工具接入
   - `read` 将文件路径解析成 canonical local text resource；目录 listing 保持现有行为且不进入文本资源机制。
   - Skill catalog 暴露其入口文档路径；`Skill` 只把名称解析为该本地文档，再调用同一个 loader。
   - 两者输出同一种通用 resource envelope；不以 `<skill-loaded>` 作为运行时状态协议。
4. Prompt 与 entry ownership
   - kernel 描述通用 resource load 的幂等、revision 和 compaction 语义，不声明 Skill 专用 loaded 状态。
   - Skill schema 保留发现用途，但不施加无条件重复加载义务。
   - terminal 不再注入 `skillsDescription` 文案；实时 Skill catalog 继续由 `buildToolset()` 从 workDir 构造。
5. 持久化与恢复
   - context assets 随现有 Session persistence 恢复。
   - ToolCallDomain 仍作为 delivery toolCallId 对应结果的生命周期事实源。
   - 恢复后只有 context asset fact 与当前 materialized History 同时满足时才复用。

## 影响范围与修改点（Impact）

- `cell/packages/ai-organ-contract/src/conversation/LocalConversationContextAsset.ts`
- `cell/packages/ai-organ-logic/src/conversationCapsule/`
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/{Read,Skill}/`
- `cell/packages/ai-core-contract/src/runtime/SkillCatalog.ts`
- `cell/packages/ai-support/src/skill/LocalFileSkillCatalog.ts`
- `cell/packages/mod-ai-kernel/src/prompt/`
- `cell/packages/ai-organ-logic/src/composer/AIAgent/ToolDefinitions.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- related focused tests

## 决策摘要

- 详见 `decisions.md`。
- 资源事实复用 Session context asset；ToolCallDomain 不扩权。
- content hash 是 revision 真源；provider visibility 是复用的必要条件。
- Skill 是临时 resolver，不是资源状态类型。

## 风险 / 权衡

- context asset 结构扩展可能影响持久化兼容 → 全部新增字段可选，旧 session 按空资源事实恢复。
- tool result 与 context asset 写入时间不同 → delivery 仅在对应 ToolCallDomain completed 且 History result 可见时生效。
- 部分范围输出可能改变调用方预期 → 保持行号格式，并用 envelope 明确 requested/delivered ranges。
- Skill raw document 与现有格式化正文略有差异 → resolver 保持当前展示内容，但资源 revision 对实际交付文本计算，后续可无状态迁移到直接文件读取。

## 兼容性设计

- Context asset 新字段全部 optional。
- `read` 输入 schema 和目录行为不变。
- Skill 名称和 catalog schema 首期保留。
- 旧工具结果没有 resource envelope/delivery 事实时不参与复用，首次调用会正常加载。

## 迁移计划

1. 先增加数据契约和纯判定逻辑及测试。
2. 接入本地 text loader 与 `read`。
3. 将 Skill 解析接入同一 loader并清理 prompt ownership。
4. 运行恢复、压缩、工具和 terminal 聚焦回归。

## 待解决问题

- URL/MCP 的 ETag、Last-Modified 和 content hash 优先级由后续 track 决定。
- 完全删除 Skill 工具时，只删除 catalog/resolver surface，不迁移 context resource facts。
