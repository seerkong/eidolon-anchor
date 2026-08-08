# 设计：自然语言 Workflow Authoring

## 两层 tool surface

- `WorkflowAuthor` 是人类意图入口：输入完整 requirement 或 edit instruction，使用 `spawnChildExecutionActor(mode=sync_wait)` 启动 Eidolon authoring actor。
- `WorkflowWorkspace`、`WorkflowCreateBundle`、`WorkflowPatchBundle` 是 actor primitives；都从 runtime 取得同一 component binding。

## 分层 prompt

Prompt 由 universal discipline、AI workflow DSL/form guide、scaffold/edit procedure、repair policy 组成。Actor 必须保持用户业务主题，选择 `AICtrlWorkflow` 或 `AIDataWorkflow`，生成完整 XNL manifest，调用 component tools 校验/发布；诊断存在时最多修复三轮。Prompt 明确禁止 shell、普通文件工具和任何外部 agent CLI。

## CLI projection

`workflow create/edit` 把自然语言组织为一个面向根 Eidolon agent 的请求，并调用本进程 `runHeadlessExec`。根 agent 使用 `WorkflowAuthor`；因此 CLI 不包含独立 LLM adapter、prompt parser 或写入逻辑。`mcp=false`，authoring 只依赖 native tools。

## 可测试性

Prompt assembly 和 tool schemas 纯测；workspace tool 使用真实临时根测；CLI 注入 fake headless runner 检查自然语言 envelope。真实 provider E2E 留给 mission 最终 cross-surface track。
