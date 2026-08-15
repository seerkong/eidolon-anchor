# 设计：修复 eidolon Windows 平台感知与沙箱兼容

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  TUI 启动 (tui_a1-main.ts)                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ configureTuiRuntime({                                  │  │
│  │   workDir, adapter, model, ...                         │  │
│  │   // 不传 metadata → normalizeTerminalRuntimeMetadata  │  │
│  │   // 自动注入 platform + sandbox_permissions +         │  │
│  │   // exec_protocol + aiWorkflow + runtimeConfig        │  │
│  │ })                                                     │  │
│  └───────────────────────────────────────────────────────┘  │
│                        ↓ outerCtx.metadata                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ recoverOrCreateShellRuntime                           │  │
│  │   outerCtxMetadata ← runtimeConfig.metadata            │  │
│  │   profileSystemPrompt ← assembleRuntimeProfile(...)    │  │
│  │   buildSystemMessages(prompt) → systemPrompts          │  │
│  │   // 追加平台块："Platform: Windows (win32)..."        │  │
│  └───────────────────────────────────────────────────────┘  │
│                        ↓ systemPrompts + outerCtx           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Agent (main / delegate)                               │  │
│  │  - 感知 platform=win32, shell=cmd.exe                  │  │
│  │  - 用 dir/where/cmd /c/powershell 替代 ls/find/grep   │  │
│  │  - bash tool spawn 时 resolveSandboxBackendSelection  │  │
│  │    → windows-elevated（runner 可用）                   │  │
│  │    → unsandboxed（runner 缺失 + 权限检查保留）         │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 2. A. 平台感知注入

### 2.1 `normalizeTerminalRuntimeMetadata` 注入

在现有注入（local_permissions、aiWorkflow、runtimeConfig）基础上追加：

```typescript
// TerminalRuntime.ts normalizeTerminalRuntimeMetadata
normalized.platform = process.platform;                    // "win32" | "darwin" | "linux"
normalized.sandbox_permissions = {
  sandbox_mode: "workspace-write",    // 默认 workspace-write
  network_access: "enabled",          // 默认网络开放
  approval_policy: "full-auto",       // 默认全自动（已有 buildExecRuntimeMetadata 可覆盖）
};
normalized.exec_protocol = {
  mode: "full-auto",                  // 默认全自动
  additional_writable_roots: [],
  ephemeral: false,
};
```

影响：tui_a1 不传 metadata 时，bash 默认 full-auto + workspace-write，不再 interactive deny。

### 2.2 `buildSystemMessages` 追加平台块

```typescript
function buildSystemMessages(prompt: string[]) {
  const platformBlock = [
    `Current platform: ${process.platform} (${os.type()}).`,
    `Shell: ${process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "zsh" : "bash"}.`,
    `Use ${process.platform === "win32" ? "Windows commands (dir, where, cmd /c, powershell -Command) instead of POSIX commands (ls, find, grep, pwd)" : "POSIX commands (ls, find, grep, pwd)"}.`,
    `Path separator: ${path.sep}${process.platform === "win32" ? " (use \\ in paths)" : ""}.`,
  ].join("\n");
  return [...prompt.map((p) => ({ role: "system", content: p })), { role: "system", content: platformBlock }];
}
```

影响：主 agent 与 delegate 的系统提示词末尾追加平台信息，模型能据此选择正确的命令。

## 3. B. Windows sandbox 分级 + Disabled 降级

对齐 Codex `exec.rs:516` 的三级模式：

| Level | 条件 | 行为 |
|---|---|---|
| `elevated` | runner 存在 + `sandbox_setup_is_complete` | spawn `eidolon-windows-sandbox-runner`（现有行为） |
| `restricted-token` | runner 存在 + setup 未完成 | spawn runner 但 restricted token（待后续 track 实现） |
| `disabled` | runner **不存在** 或配置为 disabled | **不 spawn runner**，走普通 `spawn` + 保留文件权限检查 |

### 3.1 `resolveSandboxBackendSelection` 变更

```typescript
// SandboxBackendRuntime.ts
type WindowsSandboxLevel = "elevated" | "restricted-token" | "disabled";

function resolveWindowsSandboxLevel(selection: SandboxBackendSelection): WindowsSandboxLevel {
  if (selection.sandboxMode === "danger-full-access") return "disabled";
  // 检查 runner 是否存在
  const runnerPath = resolveWindowsSandboxRunnerPath(selection);
  if (!runnerPath) return "disabled";
  // 检查 setup 是否完成（TODO: 持久化状态）
  if (windowsSandboxSetupIsComplete()) return "elevated";
  return "restricted-token";  // runner 存在但 setup 未完成
}
```

### 3.2 `buildSpawnSpec` 变更

`windows-elevated` 分支：
- runner 不存在 → 返回 `{ error: "..." }` 显式报错（不再 ENOENT 藏匿）
- level=disabled → 走 `unsandboxed`（保留 LocalPermissionEvaluator 文件权限检查）

### 3.3 `resolveWindowsSandboxRunnerPath`

优先级：`EIDOLON_WINDOWS_SANDBOX_RUNNER` env → `process.env.PATH` 搜索 `eidolon-windows-sandbox-runner.exe` → 同目录 `dist/terminal/...` → `null`

## 4. C. TUI 启动引导

对齐 Codex `windows_sandbox_prompts.rs`：

### 4.1 `tui_a1-main.ts` Windows 引导

Windows 上启动时调用 `maybeShowWindowsSandboxPrompt()`：
- level=disabled（runner 未安装）→ 弹选择："安装 runner / 用非管理员模式 / 继续 unsandboxed"
- level=restricted-token（runner 存在但未 setup）→ 弹选择："完成 setup / 继续 restricted / 退出"
- level=elevated → 正常启动（或显示 setup 中状态）

### 4.2 bash 显式报错

`WindowsSandbox.ts` 的报错改为：
```
Error: Windows sandbox runner 'eidolon-windows-sandbox-runner' not found.
Install it or set EIDOLON_WINDOWS_SANDBOX_RUNNER to its path.
Alternatively, use --dangerously-bypass-approvals-and-sandbox to run without sandbox.
```

## 5. D. bash 豁免集扩宽

`LocalPermissionEvaluator.ts` `READ_ONLY_WORKSPACE_SAFE_BASH_COMMANDS` 增加：
- Windows 命令：`dir`、`where`、`type`、`tree`、`fc`、`more`、`findstr`
- Shell：`cmd`、`powershell`、`pwsh`（仅 read-only  invocation）
- 工具：`git`（仅 log/status/diff/show 等只读子命令——通过后续解析区分，这里只加 `git` 本身为 safe，具体子命令权限走现有 evaluatePermissionRuleSet）

## 6. 风险与兼容

| 风险 | 缓解 |
|---|---|
| full-auto 默认可能过于宽松 | 保留 LocalPermissionEvaluator 文件权限检查（read/write/outside-workspace 仍受控） |
| Disabled 降级削弱 sandbox 隔离 | 与 Codex `Disabled` 模式对齐；引导用户 setup runner 以恢复隔离 |
| 平台注入 systemPrompt 被模型忽略 | 作为信息补充，不替代工具层权限检查；双重保障 |
| delegate actor 重建 systemPrompt 时平台块位置 | 追加在末尾，不破坏现有 systemPrompt 结构 |

## 7. 实施顺序

P1（先做，立即可用）：A(平台注入) + D(bash 豁免集)
P2（随后）：B(sandbox 分级 + Disabled 降级)
P3（最后）：C(TUI 启动引导)

原因：A 让 agent 知道自己在 Windows 并选用正确命令，D 让常用只读命令不被 deny——两者组合立即恢复 agent 可用性。B 消除 ENOENT。C 提供最佳 UX。
