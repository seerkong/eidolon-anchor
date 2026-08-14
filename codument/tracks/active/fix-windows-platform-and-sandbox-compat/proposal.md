# 变更：修复 eidolon 在 Windows 上的环境感知与沙箱兼容问题

## 背景和动机 (Context And Why)

在 Windows 上运行 eidolon 的 agent 会话（如 codument 项目）时，出现三类叠加的严重兼容问题，导致 agent 无法正常使用 shell：

1. **agent 无平台感知**：systemPrompt（`mod-ai-coding` 的 AGENT.md 等）与 runtime 注入（`buildSystemMessages`、`normalizeTerminalRuntimeMetadata`）完全不含平台信息；真实 TUI 主入口 `tui_a1-main.ts` 调 `configureTuiRuntime` 时不传 metadata，`normalizeTerminalRuntimeMetadata` 只注入 `local_permissions/aiWorkflow/runtimeConfig`，无 `platform`/`sandbox_permissions`/`exec_protocol`。子 delegate 通过 `buildSystemMessages(config.prompt)` 重建 systemPrompt，同样无平台感知。后果：agent 只会用 POSIX 命令（`ls`/`find`/`grep`/`pwd`），在 Windows 上失败，只能靠报错反推自己在 Windows，而报错又被吞掉。

2. **`uv_spawn 'eidolon-windows-sandbox-runner'` ENOENT**：`WindowsSandbox.ts` 常量是 `"eidolon-windows-sandbox-runner"`（无 `.exe`），仓库中不存在该 runner 的源码/产物。按 archived decisions `2026-05-30-1046-add-linux-windows-sandbox-backends` 决策 #2/#3，它是"外部依赖 helper"，缺依赖时 fail closed。但 `SandboxBackendRuntime.ts` 的 `windows-elevated` 分支直接把该名字作为 `spawn` command，无路径，报错 `ENOENT ... uv_spawn '...'` 藏在 `(no output)` 后，agent 无法诊断。

3. **bash 全被 deny**：`~/.eidolon/permissions.json` 不存在 → 空规则 → 默认 deny；`bashSegmentIsWorkspaceSafe` 豁免集（echo/pwd/ls/rg 等）太窄，`find`/`cmd /c`/`dir`/`bun --version` 全不在内 → deny。加上无平台感知，agent 不会改用豁免命令。

参考 Codex CLI（`E:\ai-dev\src\codex`）的 Windows 方案：分级 sandbox 模式（`Elevated` / `RestrictedToken` / `Disabled`）、`Disabled` 时走普通 `exec`（`exec.rs:516`）不 ENOENT、TUI 启动时主动引导 sandbox setup（`open_windows_sandbox_enable_prompt` 提供"默认沙箱/非管理员沙箱/退出"选择）、`sandbox_setup_is_complete` 持久化检查。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 让主 agent 与 delegate 都能感知运行平台（Windows/win32、shell=cmd.exe、路径分隔符），并用 Windows 命令替代 POSIX。
- `tui_a1` 不传 metadata 时也有合理默认（`sandbox_permissions`=workspace-write、`exec_protocol.mode`=full-auto、`platform`=win32）。
- Windows sandbox 分级：runner 未安装/未 setup 时走普通执行 + 保留文件权限检查（不 ENOENT），runner 可用时走 `windows-elevated`。
- TUI 启动时在 Windows 检测 sandbox 状态并引导（安装 runner / 非管理员模式 / 继续 unsandboxed+权限检查）。
- bash 报错从 ENOENT 藏匿改为显式可诊断（缺什么、怎么装/绕过）。
- 扩宽 workspace-safe bash 豁免集，覆盖 Windows 常用只读命令。

**非目标：**

- 不移植 Codex 完整的 elevated Windows sandbox（ACL/token/WFP/ConPTY 等），只做分级降级与引导。
- 不改变非 Windows 平台的 sandbox 行为。
- 不修改用户历史 session 文件。
- 不把 `platform` 注入到持久化的 conversation 历史（仅注入 systemPrompt 与 metadata）。

## 变更内容（What Changes）

- `TerminalRuntime.buildSystemMessages` 追加平台信息块。
- `normalizeTerminalRuntimeMetadata` 追加 `platform`、`sandbox_permissions`（默认 workspace-write）、`exec_protocol.mode`（默认 full-auto）。
- `SandboxBackendSelection` 增加 Windows sandbox level；`Disabled`/`RestrictedToken`（runner 缺失或未 setup）时走普通执行 + 权限检查。
- `SandboxBackendRuntime` 的 `windows-elevated` 分支增加 runner 存在性检查与显式报错。
- TUI Windows 启动引导（仿 Codex enable prompt）。
- `LocalPermissionEvaluator` 扩宽 `READ_ONLY_WORKSPACE_SAFE_BASH_COMMANDS`。
- bash 工具 detail prompt 补 Windows 命令提示。

## 影响范围（Impact）

- 受影响的能力：`windows-platform-awareness`、`windows-sandbox-fallback`、`bash-windows-commands`
- 受影响的代码：`terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`、`cell/packages/ai-organ-logic/src/sandbox/{SandboxBackendRuntime,WindowsSandbox}.ts`、`cell/packages/ai-organ-logic/src/permissions/LocalPermissionEvaluator.ts`、`terminal/packages/tui/src/entry/{tui_a1-main,thread}.ts`、`cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Bash/Tool.detail.xnl`
- 兼容性：非 Windows 平台行为不变；Windows 上 bash 从"全部 ENOENT/deny"变为"可用（权限检查内）"。