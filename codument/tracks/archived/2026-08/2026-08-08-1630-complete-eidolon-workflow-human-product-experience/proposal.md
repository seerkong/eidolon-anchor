# 变更：完成 Eidolon Workflow 人类产品体验

## 背景和动机 (Context And Why)

底层 authoring、运行、恢复和 Material 生命周期已经具备，但当前人类入口仍要求上层 agent 自己拼接多个低层工具。用户得到的是 workflow 内部机制，而不是“表达业务目标，系统完成合适编排”的产品体验。成熟参考产品已经证明：场景选择、生成、输入推断、隔离 proof、确认、实例化和执行应是一条受控产品旅程。

## “要做”和“不做” (Goals / Non-Goals)

目标：

- 提供一个对话与 CLI 共享的高层 workflow journey tool，只接收普通业务语言。
- 自动选择直接处理、AI Ctrl、AI Data 或组合模式，并按业务场景装载最小上下文。
- 在高层 journey 内协调 authoring、proof、发布、输入/Material 推断、Instance 和独立执行确认。
- 对普通用户只报告业务目的、当前进度、需要的确认、等待事项和最终结果。
- 提供 `eidolon workflow agent "<业务目标>"` 的统一自然语言入口，并保留低层专家命令。
- 用真实业务语言 corpus 验证人类无需理解 form、node、port、policy、XNL 或路径。

非目标：

- 不替换已经建立的 workflow authoring/run/Material 生命周期。
- 不复制 depa-flows 的 flow 语义或执行器。
- 不引入 MCP 或外部 agent CLI。
- 不取消专家诊断、authoring 和运行命令。

## 变更内容（What Changes）

- 增加业务场景 catalog、自然语言 intent/router 和 journey plan。
- 增加 `WorkflowFulfill` native tool，由 Eidolon actor 使用现有低层 workflow tools 完成受控旅程。
- 增加业务态投影，隔离内部 authoring/runtime facts 与人类输出。
- 增加 CLI `workflow agent`，复用同一个 high-level tool。
- 更新 kernel 路由和回归 corpus。

## 影响范围（Impact）

- 受影响能力：`eidolon-ai-workflow-native-capability`
- 受影响代码：workflow authoring/prompts/tools、AI kernel routing、terminal CLI/organ-support、相关 tests。
