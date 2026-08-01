# 变更：增加 Linux 和 Windows sandbox backend

## 背景和动机 (Context And Why)
本项目已经有 sandbox backend runtime 抽象和 macOS Seatbelt backend。当前非 macOS 平台在 `read-only` / `workspace-write` 下仍会回落到 unsandboxed 执行，这与用户对跨平台 sandbox 的预期不一致。用户要求阅读 Codex 中 Windows Elevated sandbox 与 Linux sandbox 的实现原理，并参考本项目 macOS backend 的扩展机制实现 Linux 和 Windows sandbox。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 扩展现有 `SandboxBackendRuntime`，新增 Linux 和 Windows backend selection。
- 基于 Codex Linux bubblewrap/seccomp 设计实现 Linux backend 的命令构造、执行路径和失败语义。
- 基于 Codex Windows Elevated restricted-token / ACL / runner 设计实现 Windows backend 的命令构造、setup 检查和失败语义。
- 保持 Bash 工具先走 local permission，再进入 sandbox backend。
- 补充可在非目标平台运行的单元测试，以及目标平台可用时的 smoke test。

**非目标:**
- 不重写 macOS Seatbelt backend。
- 不修改用户可见的 Bash 工具输入协议。
- 不在本 track 内强制把 Read / Write / Edit / ApplyPatch 等文件工具全部迁移到 sandbox backend。
- 不默默把 Linux/Windows sandbox 不可用降级为 unsandboxed。

## 变更内容（What Changes）
- 修改 sandbox backend 类型与 selection 逻辑，支持 `linux-bwrap` 和 `windows-elevated` 等平台 backend。
- 新增 Linux backend 模块，封装 helper/bubblewrap/seccomp 风格的命令执行接口、网络限制语义、依赖检测与错误信息。
- 新增 Windows backend 模块，封装 elevated setup 检查、restricted token/ACL/runner 风格执行接口、网络限制语义与错误信息。
- 修改 sync/streaming Bash sandbox execution，使其按 backendName 分派到平台模块。
- 扩展 sandbox backend runtime 测试，覆盖 Linux/Windows backend selection、command args、unsupported/degraded errors、timeout 和 Bash delegation。
- 无 **BREAKING** 变更；但此前非 macOS `read-only` / `workspace-write` 的隐式 unsandboxed 行为会被更严格的 sandbox/错误语义替代。

## 影响范围（Impact）
- 受影响的功能规范：`sandbox-backend-permission-runtime`
- 受影响的模块：sandbox backend runtime、Bash tool execution、sandbox tests、平台依赖检测与错误消息。
