# 设计：Zig Windows 沙箱 runner

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  SandboxBackendRuntime.ts (ai-organ-logic)                   │
│  buildSpawnSpec → windows-elevated / restricted-token        │
│    → spawn("eidolon-windows-sandbox-runner.exe", [           │
│        --cwd, --mode, --network, --writable-root,            │
│        --deny-write, --, <shell>, /d /s /c, <command>        │
│      ])                                                      │
└──────────────────────────┬───────────────────────────────────┘
                           │ spawn
┌──────────────────────────▼───────────────────────────────────┐
│  eidolon-windows-sandbox-runner.exe (Zig)                    │
│  main.zig: 解析参数 → resolve_permissions → build_restricted  │
│             → CreateRestrictedToken → capability SID →       │
│             CreateProcessAsUserW → 转发 stdio → 返回 exit    │
└──────────────────────────┬───────────────────────────────────┘
                           │ 首次需要管理员时
┌──────────────────────────▼───────────────────────────────────┐
│  eidolon-windows-sandbox-setup.exe (Zig, elevated via UAC)   │
│  setup.zig: ShellExecuteExW("runas") → 建 sandbox dir →       │
│             生成 capability SIDs → 建账号 → 装 WFP → 写 marker│
└──────────────────────────────────────────────────────────────┘
```

## 2. 已验证的 Zig 可行性（PoC）

Zig 0.16.0（本机 `C:\Users\peacock\AppData\Local\Microsoft\WinGet\Packages\zig.zig_Microsoft.Winget.Source_8wekyb3d8bbwe\zig-x86_64-windows-0.16.0`）PoC：

```zig
extern "advapi32" fn CreateRestrictedToken(...) callconv(.winapi) i32;
extern "advapi32" fn OpenProcessToken(...) callconv(.winapi) i32;
pub fn main() void {
    // OpenProcessToken(TOKEN_DUPLICATE|TOKEN_ASSIGN_PRIMARY|TOKEN_QUERY)
    // CreateRestrictedToken(flags=DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED, ...)
    // → OK，受限令牌创建成功
}
```

- 编译：`zig build-exe poc.zig -O ReleaseSafe -target x86_64-windows` ✅
- 运行：`CreateRestrictedToken OK` ✅
- 关键结论：`@extern "advapi32"` 直接链接，无需 `@cImport`/头文件。

**注意 Zig 0.16 的 std API 变化**：`std.io` 已移除（改用新的 Io 设计），Win32 调用建议直接用 `WriteFile`/`GetStdHandle` 或 `std.os.windows` 的封装，避免 std.io 编译错误。

## 3. 核心实现

### 3.1 `token.zig` —— RestrictedToken

```zig
const flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
const entries = [capability_sids..., logon_sid, everyone_sid]; // restricting SIDs
CreateRestrictedToken(base_token, flags, 0, null, 0, null, entries.len, &entries, &new_token);
```

- capability SID：为每个 workspace root 派生一个唯一 SID（`CreateWellKnownSid` + 自定义算法，或用 codex 的 `cap.rs` 思路：基于 root 路径生成确定性 SID）。
- 受限 token 的默认 DACL 设为 logon+Everyone+capabilities（让子进程能建管道）。

### 3.2 `acl.zig` —— workspace ACL

- 对 workspace root：授予 capability SID 写权限（`SetEntriesInAclW` + `SetNamedSecurityInfoW`）。
- 对 `.git`/`.eidolon`/`.agents`/`.codex`：加 deny-write ACE（`add_deny_write_ace`）。
- `--mode=read-only`：只授予读，不授予写。

### 3.3 `wfp.zig` —— WFP 网络过滤

- `network_access=disabled` 时：`FwpmEngineOpen` → 添加 `FwpmFilterAdd` 拦截 sandbox 账户/受限 SID 的出站连接。
- 需要 elevated（管理员）才能操作 WFP → 由 setup helper 安装。

### 3.4 `main.zig` —— runner 入口

```zig
// 解析参数（对齐 WindowsSandbox.ts 协议）
// --cwd <dir>, --mode <read-only|workspace-write>, --network <enabled|disabled>,
// --writable-root <dir>*, --deny-write <dir>*, -- <shell> /d /s /c <command>
// 1. resolve_permissions() → 计算 capability SIDs、ACL 变更
// 2. 若 --mode=workspace-write 且 --writable-root → 授予 ACL
// 3. build_restricted_token() → CreateRestrictedToken
// 4. CreateProcessAsUserW(token, shell, ...) → 转发 stdin/stdout/stderr → 等退出
```

### 3.5 `setup.zig` —— elevated setup

```zig
// 1. 检测是否 elevated（OpenProcessToken + GetTokenInformation(TokenElevation)）
// 2. 否 → ShellExecuteExW("runas", 当前exe, --setup) 触发 UAC，父进程等待
// 3. 是 → 建 sandbox dir、生成 capability SIDs、建离线账号（可选）、装 WFP、写 setup marker
```

### 3.6 协议对齐（WindowsSandbox.ts）

现有 `WindowsSandbox.ts` 生成：
```
--cwd <workDir> --mode <mode> --network <network> --writable-root <root> --deny-write <protected> -- <shellPath> /d /s /c <command>
```
Zig runner 解析这套参数，保持兼容。

## 4. Bun 集成

### 4.1 `SandboxBackendRuntime.ts` 的 `restricted-token` 分支

当前：
```ts
if (level === "restricted-token") {
  return { error: "Windows restricted-token sandbox is not yet implemented; ..." };
}
```
改为：`buildSpawnSpec` 走 runner（同 `windows-elevated`，只是 `--mode` 对应 restricted-token 语义）。

### 4.2 分发

复用 OpenTUI native 模式（`build.ts` L254-257 复制 `@opentui/core-<platform>-<arch>`）：
- `build.ts` 增加：构建后复制 `eidolon-windows-sandbox-runner.exe` + `eidolon-windows-sandbox-setup.exe` 到 `dist/terminal/tui/`。
- `install-dist-tui.ts` 复制两个 exe 到安装目录。
- `resolveWindowsSandboxRunnerPath()` 的 PATH 查找会命中安装后的 runner。

## 5. 测试与验证

- **Zig 单测**：`build.zig` 里 `zig test`（token 创建、ACL 变更、参数解析）。
- **集成验证**（Windows 实机）：
  - `CreateRestrictedToken` 生效：受限进程 `cmd /c echo > C:\Windows\system32\test.txt` 应失败（无写权限）。
  - ACL deny-write 生效：受限进程写 workspace 外路径失败。
  - WFP 生效：`network=disabled` 时 `curl`/`ping` 失败。
- **Bun 测试**：`sandbox_backend_runtime.test.ts` 的 `restricted-token` 分支测试改为断言 spawn runner（而非 error）。

## 6. 风险与兼容

| 风险 | 缓解 |
|---|---|
| WFP API 复杂、可能需多次迭代 | 分阶段：先 RestrictedToken+ACL（P1），WFP（P2），elevated setup（P3） |
| Zig 0.16 std API 变化 | 用 `@extern` + Win32 直调，少用 std 高层 API |
| 受限 token 破坏某些工具（git 需凭据、网络代理） | `--network=enabled` 时跳过 WFP；git 凭据走 workspace 内 |
| 管理员 setup 首次弹 UAC | 对齐 Codex：TUI 引导明确提示 |
| `disabled` 降级路径保留 | 不破坏现有降级 |

## 7. 实施顺序

- **P1**：Zig 包骨架 + `token.zig`（RestrictedToken）+ `acl.zig`（workspace ACL）+ `main.zig`（参数解析 + 受限进程）+ 构建脚本。验证：受限进程无法写 workspace 外。
- **P2**：`wfp.zig`（网络过滤）+ `setup.zig`（elevated + UAC）+ setup marker。
- **P3**：Bun 集成（`SandboxBackendRuntime.ts` restricted-token 分支接 runner + 分发脚本 + 测试）。
- **P4**：收口验证（Zig 单测 + 集成验证 + strict validate + GapLoop + AttractorCheck）。