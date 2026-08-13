# Eidolon AI Workflow Native Component and CLI

## 背景

Eidolon 已有标准化组件协议、AI tools、actor/session/runtime-control 与 terminal CLI/TUI，但缺少一个完整、共享且可恢复的 AI Workflow 产品能力。已有低层 workflow primitives、CLI 文件写入和对话入口各自为政，无法形成统一的 authoring、运行、恢复和人工确认体验。

本 mission 的核心判断是：`eidolon workflow` 不是独立实现，而是 Eidolon native workflow component 的 human-facing projection。对话 tools、CLI 与 TUI 必须共享同一个 component、authoring workspace、runtime service 和事实 authority。

## 目标

- 建立 Eidolon AI Workflow native component/service，统一承载 authoring、validation、inspection、publication、run control 与 recovery。
- 以 depa-flows 的 AICtrlWorkflow、AIDataWorkflow、WorkCtrlFlow 和 EagerDataFlow 为 flow 语义 authority。
- 支持自然语言驱动的 workflow 创建与编辑，并在隔离 VFS session 中完成 diff、validate、dry-run、repair 和独立 publication gate。
- 让对话、TUI 和 `eidolon workflow` CLI 共享相同 native tools 与 component binding。
- 复用 Eidolon actor、session、runtime-control、durable head 与 effect lifecycle；workflow 只保存 workflow facts。
- 支持 Resource Type/Instance/Run、冻结 definition revision、Material immutable revision、精确 binding、receipt、等待、恢复和回放。
- 支持 AIDataWorkflow generation、GraphPatch、传递性 invalidation、run-local semantic reuse 与节点类型默认 reuse policy。
- 普通用户只需表达业务目标，不需要理解 form、节点、端口、复用策略、XNL、FQN 或存储路径。

## 非目标

- Eidolon 集成不实现 MCP adapter。
- 不在 Eidolon 内实现第二套 flow parser、scheduler、runtime fact store 或 unrestricted file-write path。
- 不为 workflow 自造独立 actor/session/durable-head/effect-lifecycle authority。
- 不让模型直接成为最终文件写入 authority；发布必须由 workflow component 执行受控 transition。
- 不引入第二套 workflow 资源布局。

## 成功判据

- 对话、TUI 与 CLI 使用同一个有状态 WorkflowComponent 和 filesystem/resource authoring port。
- AICtrlWorkflow 通过 WorkCtrlFlow 运行；AIDataWorkflow 通过 EagerDataFlow/RunGraph 运行。
- Authoring session 提供 `/base`、`/refs`、`/work`、`/out` 四个挂载及完整审计与恢复事实。
- Publication 与 execution 是两个独立授权门；未授权时保留可恢复状态且不产生越权副作用。
- Definition、Instance、Run、Material、effect evidence 与 recovery 的 authority 边界清晰且可验证。
- CLI/TUI production build、真实多轮自然语言 E2E、跨进程 CLI continuation 和 fresh-runtime recovery 全部通过。
- 公网多来源工作流只在执行授权后访问来源，并返回包含真实标题、链接和综合分析的报告。

## 为什么使用 mission

目标横跨 contract、ai-organ-logic、terminal CLI/TUI、runtime effect integration、resource validation、持久化恢复和测试。mission 负责保持期望态 DAG、authority 边界和 track 切片；具体代码与验收由各 track 落地。
