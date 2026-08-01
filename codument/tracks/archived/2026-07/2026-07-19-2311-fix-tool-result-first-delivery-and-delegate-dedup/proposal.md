# Proposal: Tool Result First Delivery and Delegate Dedup

## Why

真实 session 中，`RunDelegateActor` 已返回约 26 KB 的仓库总结，但 cheap compaction 在下一次 provider request 之前把结果替换为 artifact wrapper，并宣称模型已经收到完整结果。主 agent 因此读取 artifact；新的大 read 结果又在首次 provider delivery 前被外置，形成多层 artifact 链。与此同时，detached delegate 没有同一父 actor 范围的在途复用，主 agent 持续创建新的 explorer actor 并重复要求总结。

这不是 OpenAI Responses stateless request 的主因：错误发生在 provider adapter 之前的 Conversation/runtime compaction 阶段。修复必须保持 stateless request 和 LLM cache 友好，不把每轮 delivery 状态塞入稳定 system instructions。

## Goals

- 新产生的普通工具结果在至少一次成功 provider request 中完整出现后，才可被视为已交付并按预算压缩或外置。
- provider 失败、中止和恢复不会错误确认 delivery。
- 大 artifact 的 read 结果不会在首次可见前再次被外置成嵌套 artifact。
- detached delegate 默认按父 actor 与 agent 类型单飞；重复调用复用现有 task。
- 显式 `task_key` 保留合法的多子任务并行能力。
- 用事故形态回归验证完整结果可见、artifact 链收敛、child actor 数量有界。

## Non-goals

- 不改变 OpenAI Responses 的 stateless 调用模式、replay checkpoint 或 provider native continuation 策略。
- 不通过动态 system prompt、cache key 或每轮 instructions 注入 delivery 状态。
- 不使用模糊语义相似度、LLM 判断或全局调用次数阈值做重复检测。
- 不改变 `sync_wait` 的等待语义。
- 不清理或提交当前 mission 的其他未提交改动。

## Changes

1. 把普通 tool call/result 的首次 provider delivery 建模为可持久恢复的 runtime/domain fact。
2. provider request 成功后按实际包含的 pending pair 确认 delivery；失败和中止保持 pending。
3. compaction 保护 pending tool call id，legacy 无 delivery fact 的旧历史保持兼容。
4. detached registry 建立 `(parent actor, agent type, task_key)` 单飞索引；缺省 `task_key=default`。
5. 重复在途调用返回原 `task_id`、状态和 `reused=true`；终态释放索引。
6. 新增 live executor、artifact convergence、registry/tool 和事故组合回归。

## Impact

- 主要影响 `ai-organ-contract`、`ai-organ-logic` 的 Conversation asset、executor、compactor、delegate tool/registry 及其测试。
- 可能增加很小的 session metadata；不改变 History 和 ToolCallDomain 中的工具执行事实。
- 单个父 actor 默认不能同时启动多个同类型 detached delegate；需要并行时调用者必须提供不同 `task_key`。

## Approval

用户在完成事故分析后明确要求创建 track 并立即按 `codument-impl-track` 修复，因此本提案视为已批准进入实现。提交模式保持 `manual`。
