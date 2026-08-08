# 变更：Workflow CLI heredoc 与跨进程 Session 续接

## 背景和动机 (Context And Why)

Workflow agent 的自然语言通常包含多行约束和多个 URL。将整段文本塞进一个 shell 参数可读性差，也难以安全维护；同时，独立 CLI 进程必须显式指向同一 Eidolon session 才能延续确认旅程。

## “要做”和“不做” (Goals / Non-Goals)

目标：

- 支持 `/dev/stdin` 和 `-` 作为显式多行用户指令输入源。
- 支持 `--session/-s`，映射到既有 headless session storage/recovery。
- 保留原有单行位置参数兼容性。
- 用本地安装后的 `eidolon-cli` 执行三次独立进程调用，完成公网多来源 workflow journey。

非目标：

- 不在缺省参数时隐式等待 stdin。
- 不创建 workflow 私有 session store。
- 不覆盖 TUI 的 `eidolon` 命令。

## 变更内容（What Changes）

- Workflow agent handler 在运行前解析显式 stdin token。
- Workflow agent builder 增加 session 参数，runtime 调用透传 session key。
- 单元测试覆盖多行保持、错误处理、session 透传和单行兼容。
- 构建并安装 CLI 后执行真实多进程 journey。

## 影响范围（Impact）

- 受影响能力：`eidolon.workflow-cli`
- 受影响代码：terminal CLI workflow command、workflow CLI tests、CLI distribution verification
