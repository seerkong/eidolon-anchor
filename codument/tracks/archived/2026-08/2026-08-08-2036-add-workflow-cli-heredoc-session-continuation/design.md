# Design

## 上下文

参考 CLI 的明确文件输入风格：命令位置参数仍存在，但 `/dev/stdin` 或 `-` 表示从标准输入读取完整正文，适合 shell heredoc。Eidolon headless runtime 已原生支持 durable `sessionKey`，workflow CLI 只需透传。

## 方案概览

1. 将 `workflow agent <requirement>` 保持为必填位置参数，避免无参数交互式调用意外挂起。
2. 当 requirement 是 `/dev/stdin` 或 `-` 时调用共享 `readHeadlessInput(undefined)`；读取结果 trim 后为空则返回 usage error。
3. 普通位置参数不读取 stdin，保持原语义。
4. 新增 `--session/-s`，传入 `runHeadlessExec.sessionKey`。
5. 三次 CLI 进程使用相同 session：首轮多行创建请求；第二轮多行发布确认并带 `--publish`；第三轮多行执行确认并带 `--yes`。
6. 安装目标使用 `~/.local/bin/eidolon-cli`，与 `~/.local/bin/eidolon` TUI 并存。
7. 真实 E2E 若暴露 authoring ABI 漂移，定义上下文必须明确 data node 的三参数调用约定、端口解包和精确输出 map；run 上下文必须明确实例输入端口 map。通过同一 session 的自然语言纠偏重新发布、重新执行，保留原失败 run 证据。

## 风险 / 权衡

- `/dev/stdin` 是 POSIX 路径；跨平台明确使用 `-`，两者语义一致。
- 真实模型可能需要较长时间；installed E2E 保留完整输出和持久化 facts 作为裁决证据。
- Session 只是现有 Eidolon conversation authority 的键，不承担 workflow facts。
- 报告逻辑错误不得用手工改临时 workspace 冒充修复；必须由更新后的产品上下文驱动 workflow actor 自行纠偏。

## 决策摘要

- 显式 stdin token，不做无参数隐式 stdin。
- 复用 headless durable session，不创建 CLI 特例。
- TUI 与 CLI 二进制名称保持并存。
