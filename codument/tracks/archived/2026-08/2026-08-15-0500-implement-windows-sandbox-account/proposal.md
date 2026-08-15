# 变更：实现独立沙箱账号（Windows 进程级隔离）

## 背景和动机 (Context And Why)

当前 eidolon 的 Windows sandbox（`implement-windows-sandbox-runner` track）实现了 RestrictedToken + capability SID + ACL，但在真实运行中**默认 disabled**（直接执行 + LocalPermissionEvaluator 文件校验），未达 Windows 沙箱等效能力。

**根因（已实验验证）**：我们的受限令牌走的是"当前用户特权令牌 → CreateRestrictedToken 降级"路径。Cygwin/MSYS 工具（Git Bash 的 find/ls/grep）启动时调用 `NtSetInformationToken(TokenDefaultDacl)` 设置令牌默认 DACL，而**从特权令牌降级得到的 restricted token 拒绝该调用**（`0xC0000022`），Cygwin 初始化中止；`bun` 同样静默失败。加 Everyone restricting SID 无效（实验确认错误不变）——问题在**降级路径**，不在 SID 列表。

**正确的做法**：用**独立沙箱账号**。setup 时用 `NetUserAdd` 创建受限本地账号（USER_PRIV_USER、非管理员），进程以该账号 token `CreateProcessAsUserW` 启动。账号是**全新普通用户**（从未是特权令牌），Cygwin/bun 能正常初始化，但文件/网络受该账号权限限制——进程级隔离真正生效。

**目标**：实现独立沙箱账号方案，达到 Windows 进程级隔离，同时保持 Cygwin/bun 工具链可用。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- `setup.zig` 扩展：elevated 时用 `NetUserAdd` 创建受限沙箱账号（`eidolon-sandbox`，USER_PRIV_USER，随机密码），`NetLocalGroupAddMembers` 可选加组，密码 DPAPI 加密存 `%LOCALAPPDATA%\eidolon\windows-sandbox\`。
- `main.zig` 扩展：以沙箱账号 `LogonUserW` 获取 token → `CreateProcessAsUserW` 启动命令（替换当前 restricted-token 路径）。
- workspace ACL：对沙箱账号 SID 授权写（复用 acl.zig，capability SID → 账号 SID）。
- `SandboxBackendRuntime.ts`：Windows 沙箱恢复为**默认启用**（不再是恒 disabled），`windowsSandboxLevel=elevated` 走账号沙箱；runner 缺失/未 setup 时降级 disabled。
- `sandbox_setup_is_complete` 检查：Bun 侧读 setup marker。
- WFP 网络过滤：`network=disabled` 时用 setup 安装的 WFP 拦沙箱账号（复用 wfp.zig 基础绑定，补 `FwpmFilterAdd`）。
- TUI 启动引导：Windows 检测 setup 未完成时提示用户运行 setup（UAC）。

**非目标：**

- 不做跨平台：仅 Windows。
- 不迁移历史 session。
- 不实现 `danger-full-access` 之外的全权限语义；disabled 降级保留。
- 不改变非 Windows 平台沙箱行为。

## 变更内容（What Changes）

- `cell/packages/windows-sandbox-runner/src/`：
  - `setup.zig`：账号创建（NetUserAdd/NetLocalGroupAddMembers）、密码 DPAPI、marker。
  - `main.zig`：LogonUserW + CreateProcessAsUserW 以账号启动。
  - `acl.zig`：账号 SID 授权。
  - `wfp.zig`：FwpmFilterAdd 完整过滤。
- `cell/packages/ai-organ-logic/src/sandbox/SandboxBackendRuntime.ts`：Windows 默认 elevated（账号沙箱），setup 未完成降级 disabled；`sandbox_setup_is_complete` 检查。
- `scripts/install-dist-tui.ts` / `build-terminal-tui.ts`：setup/runner 分发（已有）。
- `terminal/packages/tui/src/entry/thread.ts`：setup 引导。

## 影响范围（Impact）

- 受影响的能力：`windows-sandbox-account`（新）
- 受影响的代码：`windows-sandbox-runner` Zig 包、`SandboxBackendRuntime.ts`、`thread.ts`
- 兼容性：Windows 默认从"无进程隔离"变为"账号沙箱隔离"；Cygwin/bun 保持可用（账号是普通用户）。