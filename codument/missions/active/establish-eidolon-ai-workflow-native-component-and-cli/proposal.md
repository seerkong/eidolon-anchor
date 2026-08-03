# Mission：establish-eidolon-ai-workflow-native-component-and-cli

## 背景和动机

Eidolon 需要原生集成 AI workflow 能力，使对话过程中的 AI agent 能够创建、编辑、校验并执行 workflow，同时终端用户也能通过 `eidolon workflow ...` 使用同一套能力。

前置工作已经建立了 AI workflow contract、基础 workflow native tools 和 `.eidolon` 运行根概念，但这些能力还没有收敛为一个可复用的 Eidolon workflow component，也没有形成 CLI 与对话 tool 共享的 command/query 基础设施。

本 mission 的关键判断是：`eidolon workflow` 不是独立 CLI 产品，而是 Eidolon native workflow component 的 human-facing projection。对话内 tool 和 CLI 必须共享同一个 component/service，避免 CLI、tool、运行期各自实现一套 workflow 逻辑。

## 目标

- 建立 Eidolon AI Workflow native component/service 层，统一承载 workflow authoring、validation、inspection、patch、run control 的 command/query。
- 将 workflow 创建、修改、校验、检查和执行能力暴露为 Eidolon 对话内普通 AI tools。
- 增加 `eidolon workflow` CLI 命令族，让终端入口调用同一套 workflow component/service。
- 运行期尽量复用 Eidolon 已有 actor、session、runtime-control、durable head 与 effect lifecycle；workflow 自己只保存 workflow facts。
- Authoring resource 必须遵守 XNL resource bundle 标准和安全 resource ref 约束，不接受 host absolute path、裸相对路径、traversal、`file://`、`http://` 等不受控引用。
- 形成多 track 可持续落地路径：先 component/tool，再 CLI authoring，再 runtime run/resume/status。

## 非目标

- 本次 Eidolon 集成不实现 MCP adapter。MCP 只属于 depa-flows 独立使用场景。
- 不把 sparrow-fabric 的 flow 实现迁入 Eidolon；AI workflow 核心语义以 depa-flows 的 AI workflow 产品族为基础。
- 不为 workflow 自造独立 session store、actor store、durable head 或 effect lifecycle。
- 不让 AI 直接成为最终文件写入 authority；AI 可以产出 structured draft / patch，但最终写入应由 workflow component 执行受控 transition。
- 不把 `.sparrow` 资源布局引入 Eidolon。

## 成功判据

- 对话内 workflow tools 与 CLI 命令共享同一个 workflow component/service；没有平行实现的核心 workflow 逻辑。
- `WorkflowInspectCapability` 能在 Eidolon runtime metadata 中看到 workflow roots 已注入。
- `eidolon workflow init ai-data <name>` 与 `eidolon workflow init ai-ctrl <name>` 能生成合法 XNL bundle。
- `eidolon workflow validate <ref-or-path>` 返回结构化诊断，并复用 component validation。
- 对话内 tool 能通过同一 component 创建或 patch workflow bundle，并在写入后校验。
- 第一阶段运行能力可通过 tool/CLI 发起 workflow run、读取 status/events/result/resume，且 workflow effect 执行复用 Eidolon actor/session/runtime-control。
- 相关 tests 覆盖 contract、tools、CLI parser、root injection、resource validation 与至少一个 smoke workflow authoring path。

## 为什么需要 mission 而不是单个 track

该目标横跨 contract、ai-organ-logic tools/component、terminal CLI、runtime effect integration、resource validation、测试与 Codument 行为设计。单个 track 容易把 CLI、tool、运行期混在一起，或者让某个 surface 偷偷成为 authority。

mission 负责保持期望态 DAG、事实边界和 track 切片；真实代码、规范和测试落地由后续真实 track 承担。
