# 变更：增加 sandbox backend / permission runtime 执行抽象

## 背景和动机 (Context And Why)
当前本项目的 Bash 工具在本地权限判断后直接通过 Node 子进程执行。它已有 Codex 风格的 `sandbox_permissions` 元数据和 local permission runtime，但缺少 Sparrow 风格的 sandbox backend 抽象，导致平台级隔离无法统一接入。用户要求参考 Sparrow 的抽象方式，并在 macOS 细节上参考 Codex 的 Seatbelt 实现。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 引入平台无关的 sandbox backend selection 和 execution runtime。
- 将 Bash 工具执行路径切到 sandbox backend runtime。
- 添加 macOS Seatbelt backend，使用 `/usr/bin/sandbox-exec` 和 deny-by-default policy。
- 支持 `read-only`、`workspace-write`、`danger-full-access`、`network_access` 和 additional writable roots。
- 保持现有 local permission / approval 行为在 sandbox 执行之前生效。

**非目标:**
- 不一次性重构所有文件工具和 Web 工具的权限系统。
- 不实现 Linux bubblewrap 或 Windows sandbox backend。
- 不改变现有用户交互审批 UI。
- 不自动提交 Git commit。

## 变更内容（What Changes）
- 新增 sandbox backend runtime 模块。
- 新增 macOS Seatbelt policy builder。
- 修改 Bash tool，使其通过 sandbox backend runtime 执行命令。
- 新增单元测试覆盖抽象、policy 生成和 Bash 集成。

## 影响范围（Impact）
- 受影响的功能规范：本地工具执行、安全隔离、终端 exec。
- 受影响代码：`cell/packages/ai-organ-logic` 的 Bash 工具、权限运行时相邻模块和测试。
