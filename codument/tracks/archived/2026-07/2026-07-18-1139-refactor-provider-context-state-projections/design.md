## 上下文

History 记录完整工具协议，ToolCallDomain 记录调用生命周期，Conversation 三域负责 provider context 物化。当前缺少的是一个通用的、可持久化的 provider projection 生命周期：工具产生的可变状态没有逻辑 key/revision，也没有“该 source pair 已成功交付一次”的事实。

## 方案概览

1. Tool context effect
   - 工具可返回一个标准 envelope，其中 `output` 是交付给模型的精简结果，`contextEffects` 描述零到多个 provider projection 更新。
   - mutable projection effect 至少包含 logical key、revision、content 和 placement。
   - executor 统一解包并把当前 `toolCallId` 关联为 source；不按工具名分支。
2. Projection fact owner
   - projection fact 复用 Conversation Session context owner 和现有 persistence，不创建 executor 私有 map。
   - 同一 actor + projection key 使用稳定 asset identity；新 revision 替换 current content，同时保留 source/delivery 审计引用。
   - projection 是可重建派生事实；TaskTree 的权威状态仍是 `actor.taskTree`。
3. First delivery
   - 新 source pair 初始为 undelivered，当前 provider materialization仍包含完整 call/result。
   - prompt build 返回本次可确认的 source tool-call ids。
   - provider 成功完成后，shared lifecycle helper 把这些 source 标记 delivered；失败不确认。
   - streaming 和 cooperative 路径调用同一 helper。
4. Provider materialization
   - 从当前 actor 的 projection facts 收集 delivered source ids。
   - 对 assistant message 中选定的 tool call 和对应 tool result 按 id 成对过滤；混合多 tool-call assistant 只移除选定 call，保留其他 call/content。
   - 如果 assistant 在移除 tool call 后没有任何内容、reasoning 或其他 call，则删除空 assistant。
   - History-visible view 和持久化文件完全不变。
5. Late projection
   - 对当前 projection facts 按 key 稳定排序，生成 system context message。
   - 复用并推广现有 late-status placement：插在最后一个 user 前；无 user 时插在完整尾部工具组前。
   - 同一 key 只 materialize 当前 revision，不累积旧 revision。
6. TaskTree adoption
   - TaskTreeWrite 在成功 mutation 后生成当前树 revision 和 render，发布 generic mutable projection effect。
   - 工具结果缩为包含 projection key/revision 的 compact acknowledgement。
   - materializer 与 executor 生命周期代码不识别 `TaskTreeWrite` 名称。
7. Profile-owned prompt recovery
   - shell control actor 的 profile baseline prompt 使用显式 slot/provenance，至少记录 profile identity、prompt index 与 content digest；用户/自定义 prompt 仍保留在原数组位置。
   - 新建 shell runtime 时由 profile assembly 提供 baseline prompt 并登记 provenance；terminal 只选择 profile 和传递 assembly 结果，不拥有提示词正文或迁移判断。
   - 恢复时 bootstrap 仅替换 provenance 指向且 digest 匹配的 profile-owned slot，再更新 provenance；actor key/id、model/work/task state、mailbox、History、其他 actor 与自定义 prompt 不变。
   - legacy snapshot 无 provenance 时只允许两类确定迁移：空 prompt 时插入当前 profile prompt；shell control actor 恰好一条 prompt 时把该条认领为 legacy profile baseline 并替换。多条 prompt 时不猜测，保持原样并发出结构化诊断。
8. Live session verification
   - 使用当前源码 CLI，以显式 workspace 和 session id 恢复目标 snapshot；使用 workspace-bounded full-auto 和有界 auto-resume 执行原 mission 归档。
   - 执行前后保存 git status、History/effects/prompt/projection 摘要和 mission 目录状态；不 reset、clean 或覆盖目标 workspace 既有改动。
   - 若仍出现 TaskTree/Skill 重复且不执行归档，立即停止继续放大现场，基于 provider materialization、resource visibility、projection facts、persisted prompt 和 effect lifecycle 做证据化分析；不添加次数、进度或 mission 特例。

## 影响范围与修改点（Impact）
- `cell/packages/ai-core-contract/src/types.ts`
- `cell/packages/ai-organ-contract/src/conversation/LocalConversationContextAsset.ts`
- `cell/packages/ai-organ-logic/src/conversationCapsule/`
- `cell/packages/ai-support/src/conversation/local/LocalConversationRuntime.ts`
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/TaskTreeWrite/`
- `cell/packages/ai-core-contract/src/runtime/AiAgentActor.ts`
- `cell/packages/ai-core-contract/src/runtime/RuntimeSnapshotTypes.ts`
- `cell/packages/ai-organ-logic/src/runtime/ShellRuntimeBootstrap.ts`
- `cell/packages/ai-support/src/runtime/LocalFileRuntimeSnapshotRepository.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- focused Conversation, executor, persistence, and TaskTree tests

## 决策摘要
- History 保留完整事实；provider-only view 负责 pair elision。
- source pair 只有在成功 provider completion 后才成为 delivered。
- projection producer 声明 context effect，consumer 只理解通用 contract。
- TaskTree state 使用单一 current projection，不作为 materializer 特例。
- Profile prompt 由 profile assembly 拥有；recovery bootstrap 只协调显式 owner slot，terminal 不拥有正文。
- legacy prompt migration 只处理空/单条确定形态，多条无 provenance 时保守跳过。

## 风险 / 权衡
- 混合 tool-call assistant 过滤可能产生协议异常 → 以 `tool_call_id` 做成对变换，并覆盖多 call/content case。
- provider failure 后误消隐结果会丢失首次交付 → 仅在 successful completion 后确认 delivery。
- persistence 恢复可能丢 projection 生命周期 → 复用现有 Session context asset round-trip 并增加恢复测试。
- previous-response continuation 与改变后的 provider view 不一致 → projection revision或 elision 集变化时通过现有 continuation baseline reset 规则失效旧 continuation identity。
- 恢复时覆盖用户自定义 prompt → 使用 owner slot + digest；legacy 多条 prompt 不自动认领。
- 真实 session 验证会修改目标 workspace → 使用用户指定 workspace/session、full-auto 仅限 workspace，并记录前后状态；不做破坏性清理。

## 兼容性设计
- 不带 context-effect envelope 的现有工具输出保持原样。
- 旧 context assets 没有 projection fact 时按空集合恢复。
- 旧 History 全量保留；只影响新 provider request 的纯投影。
- 现有 resourceFact 字段和资源可见性判定保持兼容。
- 旧 snapshot 无 prompt provenance 时兼容恢复；只有确定的空/单条 shell control prompt 自动迁移。

## 迁移计划
1. 先增加 contract、纯 materialization 和 persistence 失败测试。
2. 实现 projection fact upsert、pair elision 与 late projection。
3. 接入 executor first-delivery 生命周期和 TaskTree producer。
4. 运行 streaming/cooperative、conversation persistence、TaskTree 和受影响包回归。
5. 增加 profile prompt provenance 与 owner-aware recovery reconciliation 测试并实现。
6. 用当前源码恢复目标 session 执行 mission 归档；成功则验证归档，失败则保存现场并形成分析建议。

## 待解决问题
- 未来其他 mutable-state producer 可逐步采用同一 envelope；本 track 只完成 TaskTree 的首个真实 adoption。
- legacy 多 prompt snapshot 的显式人工认领/升级工具由后续需求决定；本 track 不做启发式归属猜测。
