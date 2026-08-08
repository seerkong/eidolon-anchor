# 变更：增加 Eidolon 自然语言 Workflow Authoring

## 背景和动机

共享 authoring workspace 已解决 TUI 写入缺失和 CLI 私有写入问题，但当前公开入口仍要求用户理解 form、FQN、manifest ref 和 XNL。产品目标是让用户直接描述业务流程，由 Eidolon 自身 actor 选择两类 workflow、生成/修改 canonical XNL、修复诊断并发布。

## 目标

- 增加高层 `WorkflowAuthor` tool，以自然语言 requirement/edit instruction 启动 Eidolon 内部 authoring actor。
- 增加模型可用的 `WorkflowWorkspace` authoring primitives，覆盖 tree/read/search/diff/validate/write/delete，且继续通过 component authority。
- 增加分层 prompt assets，明确 form 选择、canonical XNL、proof/repair/publish loop；不调用外部 agent CLI。
- 增加 `eidolon workflow create` 和 `edit`，通过本进程 headless Eidolon runtime 调用同一个高层能力。
- 在 `mod-ai-kernel` 写入简洁的自然语言路由规则。

## 非目标

- 不在本 track 实现 Ctrl/Data workflow substrate execution。
- 不做 MCP；不复制 depa-flows parser。
- 不承诺模型对任意复杂需求一次生成成功；必须通过 bounded proof/repair loop 收敛或返回诊断。

## 影响

- model-visible workflow tool set 增加高层 coordinator 和 workspace primitives。
- CLI 新增面向人的 create/edit 主入口，init 仍作为确定性低层入口。
