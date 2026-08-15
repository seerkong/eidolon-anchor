# 设计：独立沙箱账号（Windows 进程级隔离）

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  TUI 启动 → thread.ts 检测 setup 未完成 → 提示运行 setup     │
│  setup.exe（elevated, UAC）:                                  │
│    NetUserAdd("eidolon-sandbox", USER_PRIV_USER, 随机密码)   │
│    NetLocalGroupAddMembers(可选)                              │
│    DPAPI 加密密码 → %LOCALAPPDATA%\eidolon\windows-sandbox\  │
│    写 setup.marker.json                                      │
│    安装 WFP 过滤（network=disabled 时）                       │
└──────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────────┐
│  bash 执行 → SandboxBackendRuntime → windowsSandboxLevel:     │
│    elevated（setup 完成 + runner 存在）→ spawn runner         │
│    disabled（未 setup / runner 缺失）→ 直接执行 + 文件校验    │
└─────────────────────────┬────────────────────────────────────┘
                          │ spawn
┌─────────────────────────▼────────────────────────────────────┐
│  eidolon-windows-sandbox-runner.exe（账号模式）:               │
│    LogonUserW("eidolon-sandbox", 密码) → token                │
│    workspace 对该账号 SID ACL 授权（acl.zig）                 │
│    CreateProcessAsUserW(账号 token) → 命令在账号下运行        │
└──────────────────────────────────────────────────────────────┘
```

## 2. 为什么独立账号能解决 Cygwin/bun 问题

- 我们的 restricted-token 走"当前用户特权令牌降级"路径 → Cygwin 的 `NtSetInformationToken(TokenDefaultDacl)` 被拒（0xC0000022）。
- 独立账号是**全新普通用户**（USER_PRIV_USER，从未是特权令牌），其 token 允许 Cygwin 正常初始化，bun 也能运行。
- 账号无管理员权限、无高特权 → 命令无法做系统级修改（进程级隔离）。

## 3. 参考（已验证）

独立沙箱账号方案（`NetUserAdd` 建账号 + `LogonUserW` 登录 + `CreateProcessAsUserW` 启动）的已验证模式：
- `NetUserAdd`（USER_PRIV_USER, UF_SCRIPT | UF_DONT_EXPIRE_PASSWD, 随机密码）
- `NetLocalGroupAddMembers`
- 密码 DPAPI 加密存本地路径（`%LOCALAPPDATA%\eidolon\windows-sandbox\`）
- 账号可选隐藏

## 4. 核心实现

### 4.1 setup.zig 账号创建

```zig
// elevated 模式
const USER_INFO_1 = extern struct {
  usri1_name: [*:0]u16,
  usri1_password: [*:0]u16,
  usri1_password_age: u32,
  usri1_priv: u32,      // USER_PRIV_USER = 1
  usri1_home_dir: ?[*:0]u16,
  usri1_comment: ?[*:0]u16,
  usri1_flags: u32,     // UF_SCRIPT(0x1) | UF_DONT_EXPIRE_PASSWD(0x10000)
  usri1_script_path: ?[*:0]u16,
};
NetUserAdd(null, 1, &user_info, &parm_err);
```

### 4.2 main.zig 账号启动

```zig
LogonUserW("eidolon-sandbox", null, 密码, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, &token);
CreateProcessAsUserW(token, ...);  // 同现有，但 token 来自账号
```

### 4.3 acl.zig 账号授权

- workspace root 对**账号 SID**（`LookupAccountNameW` 取）授权写，而非 capability SID。
- 保留继承（已修复的 PROTECTED_DACL 问题）。

### 4.4 wfp.zig 完整过滤

- `FwpmEngineOpen` → `FwpmTransactionBegin` → `FwpmFilterAdd`（block 出站，针对账号 SID）→ `FwpmTransactionCommit`。
- setup（elevated）时安装；`network=disabled` 时生效。

### 4.5 SandboxBackendRuntime.ts

- `resolveWindowsSandboxLevel`：runner 存在 + `sandbox_setup_is_complete`（读 marker）→ `elevated`；否则 disabled。
- `sandbox_setup_is_complete`：读 `%LOCALAPPDATA%\eidolon\windows-sandbox\setup.marker.json`。

## 5. 测试与验证

- **Zig 单测**：账号创建/删除（临时账号）、LogonUserW、DPAPI 加解密。
- **集成验证**（Windows 实机）：
  - setup（UAC）创建 `eidolon-sandbox` 账号 + marker。
  - 受限进程（账号下）：`find`/`ls`/`grep`/`bun` 正常运行。
  - 账号无权限写 workspace 外。
  - `network=disabled` 时出站被 WFP 拦。
- **Bun 测试**：`resolveWindowsSandboxLevel` elevated/disabled 分支。

## 6. 风险与兼容

| 风险 | 缓解 |
|---|---|
| 账号创建需 elevated（UAC 弹窗） | TUI 启动引导 + setup 自动触发 |
| 账号密码安全 | DPAPI 加密存储；随机强密码 |
| 账号残留 | setup 记录账号名，可删除（cleanup） |
| workspace ACL 对账号授权 | 复用 acl.zig（保留继承） |
| WFP 影响系统网络 | 仅拦 sandbox 账号 SID；可卸载 |
| 与现有 restricted-token 冲突 | 账号模式替换之；restricted-token 保留为 fallback |

## 7. 实施顺序

- **P1**：setup.zig 账号创建 + marker；main.zig LogonUserW + CreateProcessAsUserW（账号模式）。
- **P2**：acl.zig 账号 SID 授权；SandboxBackendRuntime 默认 elevated + setup 完成检查。
- **P3**：wfp.zig 完整过滤；TUI setup 引导。
- **P4**：收口验证（Zig + Bun 测试、实机隔离验证、GapLoop + AttractorCheck）。