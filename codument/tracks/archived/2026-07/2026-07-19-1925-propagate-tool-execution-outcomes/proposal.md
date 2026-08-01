# 变更：贯通工具执行 outcome

## 背景和动机 (Context And Why)

coding E2E 证明 agent 可以从测试文本继续修复，但同时暴露了一条通用事实断层：Bash 已观测到进程退出码 1，进入 executor 后却只剩普通字符串，因此 ToolCallDomain、History 和 exec trace 将失败测试记录为成功。模型目前依赖阅读输出文本补偿这个缺口，降低了行动—观察—判断闭环的可靠性。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**

- 扩展通用 ToolExecutionResultEnvelope，使工具能显式返回 completed/failed 与 failureKind。
- 在共享结果规范化点一次性解析 outcome，并贯通 streaming/cooperative、ToolCallDomain、semantic history、runtime evidence 与恢复路径。
- 让 Bash 把已有 process outcome 映射到通用 contract，非零退出可靠标记失败且保留输出诊断。
- 保留旧字符串工具的兼容推断，并以测试防止回退到工具名称分支。

**非目标:**

- 不增加 terminal prompt injection、无进展检测、循环次数限制或自动纠偏。
- 不修改 Responses continuation、动态 state placement 或资源加载机制。
- 不把 Bash 进程字段硬编码进通用 ToolCallDomain schema；通用层只拥有 status/failureKind/output。
- 不在本 track 迁移所有现存工具到显式 outcome。

## 变更内容（What Changes）

- 在 ai-core contract 增加 tool execution outcome 数据类型并扩展结果 envelope。
- 让 executor 的共享 tool-result leaf 输出 normalized status/failureKind，并由两条执行路径统一消费。
- 让 ToolCallDomain 和 recovery 路径保存/恢复显式失败事实。
- 让 sandbox sync/streaming 结果在 Bash adapter 内映射为 completed/failed envelope。
- 增加 contract、executor、sandbox、Bash 和 headless E2E 测试。

## 影响范围（Impact）

- 受影响能力：`tool-call-domain-lifecycle`、`sandbox-backend-permission-runtime`
- 受影响代码：ai-core tool contract、ToolCallDomain、AiAgentExecutor、Bash tool adapter、sandbox process runtime、runtime snapshot recovery、terminal headless trace tests
