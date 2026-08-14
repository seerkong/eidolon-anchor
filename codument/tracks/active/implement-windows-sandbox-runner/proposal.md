# 变更：实现 Zig Windows 沙箱 runner（RestrictedToken + ACL + WFP + Elevated）

## 背景和动机 (Context And Why)

eidolon 的 Windows sandbox 目前只有"分级降级"：`windowsSandboxLevel=disabled` 时 bash 直接执行（靠 `LocalPermissionEvaluator` 文件权限兜底），`restricted-token` 分支返回 "not yet implemented"，`elevated` 需要一个仓库里**不存在**的 `eidolon-windows-sandbox-runner` 二进制（archived decisions `2026-05-30` 只约定了名字，从未实现）。结果：Windows 上**没有真正的系统级沙箱**（无进程级隔离、无网络过滤），只能靠纯 TS 的文件路径检查。

参考 Codex 的完整 Windows 沙箱方案（`codex-rs/windows-sandbox-rs`）：
- **RestrictedToken**：`CreateRestrictedToken`（flags=`DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED`）+ restricting SIDs（capability SIDs + 登录 SID + Everyone），用受限令牌 `CreateProcessAsUserW` 起命令。
- **capability SID + ACL**：每个 workspace root 一个 capability SID，ACL 只对该 SID 授权写 → 命令只能写工作区；对 `.git`/`.eidolon` 加 deny-write ACE。
- **WFP 网络过滤**：`network_access=disabled` 时用 Windows Filtering Platform 拦截出站连接。
- **Elevated setup**：`ShellExecuteExW("runas")` 触发 UAC → setup helper 建账号、装 WFP、写 setup marker。
- **两级模式**：`RestrictedToken`（Unelevated，不需管理员，无网络过滤）+ `Elevated`（需一次管理员 setup，完整隔离）。

**关键可行性验证已完成**：用本机 Zig 0.16.0（`C:\Users\peacock\...\zig-x86_64-windows-0.16.0\zig.exe`）编译并运行了 PoC，成功调用 `OpenProcessToken` + `CreateRestrictedToken`（flags 同上），证明 **Zig 能直接 `@extern "advapi32"` 链接 Windows API 并产出原生 `.exe`**（PoC 见 `analysis/knowledge.md`）。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 用 Zig 实现两个原生 Windows 二进制：
  - `eidolon-windows-sandbox-runner.exe`：命令执行器，从 `EIDOLON_WINDOWS_SANDBOX_RUNNER`/PATH 定位，用受限令牌 + capability SID + ACL 起进程，支持 `--cwd/--mode/--network/--writable-root/--deny-write`。
  - `eidolon-windows-sandbox-setup.exe`：elevated 安装器（UAC），建 setup marker、capability SIDs。
- 与现有 `WindowsSandbox.ts` 协议一致（参数兼容），`SandboxBackendRuntime.ts` 的 `restricted-token` 分支从 "not yet implemented" 改为真正 spawn runner。
- 构建/安装脚本把两个 `.exe` 分发到 `dist/terminal/tui/` 和安装目录（复用 OpenTUI native 分发模式）。
- 提供受控的测试/验证：`CreateRestrictedToken` 生效（受限进程无法写工作区外路径、能写 `--writable-root` 内路径）、ACL deny-write 生效。
- WFP 网络过滤：仅实现基础绑定（`FwpmEngineOpen/Close` + 结构体 + `wfpAvailable` 检测）；完整过滤（`FwpmFilterAdd` + 事务 + 持久化）为后续增强。

**非目标：**

- 不做跨平台：仅 Windows（`target=x86_64-windows`）。
- 不实现 `--danger-full-access` 之外的全权限沙箱语义；`disabled` 降级路径保留。
- 不移植 Codex 的 DPAPI 密码加密的完整账号体系（首版用受限令牌 + capability SID，账号体系作为可选增强）。
- **不实现完整 WFP 网络过滤**（`network=disabled` 时无网络隔离，为已知限制）；WFP 完整过滤（`FwpmFilterAdd`）与 elevated setup 的 TS 侧接线为后续增强。
- 不改变非 Windows 平台的 sandbox 行为。

## 变更内容（What Changes）

- 新增 `cell/packages/windows-sandbox-runner/`（Zig 包）：
  - `build.zig`（Zig 0.16 构建脚本，产出两个 exe）
  - `src/main.zig`（runner 入口 + 参数解析）
  - `src/setup.zig`（elevated setup 入口）
  - `src/token.zig`（CreateRestrictedToken + capability SID）
  - `src/acl.zig`（workspace ACL / deny-write）
  - `src/wfp.zig`（WFP 网络过滤）
  - `src/win32.zig`（Windows API @extern 绑定）
  - `package.json`（元数据 + bin）
  - `scripts/build.zig.ts`（调 zig build 的 Bun 脚本）
- 修改 `cell/packages/ai-organ-logic/src/sandbox/SandboxBackendRuntime.ts`：`restricted-token` 分支真正 spawn runner。
- 修改 `cell/packages/ai-organ-logic/src/sandbox/WindowsSandbox.ts`：协议文档/参数对齐。
- 修改 `scripts/build-terminal-tui.ts` / `terminal/packages/tui/scripts/build.ts`：分发两个 exe 到 dist。
- 修改 `scripts/install-dist-tui.ts`：分发两个 exe 到安装目录。

## 影响范围（Impact）

- 受影响的能力：`windows-sandbox-runner`（新）
- 受影响的代码：`cell/packages/ai-organ-logic/src/sandbox/{SandboxBackendRuntime,WindowsSandbox}.ts`、`scripts/build-terminal-tui.ts`、`terminal/packages/tui/scripts/build.ts`、`scripts/install-dist-tui.ts`
- 新增：`cell/packages/windows-sandbox-runner/`（Zig 包）
- 兼容性：非 Windows 不变；Windows 上 `restricted-token` 从"报错"变为"真正隔离"；`disabled` 降级保留。