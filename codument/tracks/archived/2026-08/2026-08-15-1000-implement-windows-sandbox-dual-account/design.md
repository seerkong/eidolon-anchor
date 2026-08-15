# 设计：双账号 Windows 沙箱

## 1. 架构

```
setup.exe（elevated）:
  createSandboxAccount("eidolon-sandbox-online")   → 密码 online.bin
  createSandboxAccount("eidolon-sandbox-offline")  → 密码 offline.bin
  installOutboundBlockForSid(offline SID)          → WFP 拦 offline 出站
  写 marker

runner.exe:
  --network enabled  → loginSandboxAccount(online)  → CreateProcessAsUserW
  --network disabled → loginSandboxAccount(offline) → CreateProcessAsUserW
```

## 2. 账号命名与密码文件

| 账号 | 密码文件 | WFP | 用途 |
|---|---|---|---|
| `eidolon-sandbox-online` | `account-password-online.bin` | 无 | 联网命令 |
| `eidolon-sandbox-offline` | `account-password-offline.bin` | 拦出站 | 隔离命令 |

## 3. 核心改动

### account.zig
- `SANDBOX_ACCOUNT_ONLINE = "eidolon-sandbox-online"`、`SANDBOX_ACCOUNT_OFFLINE = "eidolon-sandbox-offline"`。
- `createSandboxAccount(allocator, name)` 参数化（现固定名）。
- `passwordFileFor(name)`：online → online.bin，offline → offline.bin。
- 保持幂等（NetUserSetInfo 更新密码）。

### setup.zig
- 建 online + offline 两账号，各自加密密码写文件。
- `lookupAccountSid("eidolon-sandbox-offline")` → `installOutboundBlockForSid`。
- marker 记录两账号名 + WFP 已装。

### main.zig
- `loginSandboxAccount(allocator, name)` 参数化（现固定名）。
- `--network disabled` → login offline；否则 online。
- `--network` 现在决定账号 → 真正生效。

### SandboxBackendRuntime.ts
- 已传 `--network`（WindowsSandbox 协议）。无需改。

## 4. 升级路径

- 旧 `eidolon-sandbox` 单账号：setup 跑双账号后可 `deleteSandboxAccount("eidolon-sandbox")` 清理。

## 5. 测试与验证

- **Zig 单测**：双账号创建/密码文件、offline SID 查找。
- **集成**（需交互终端 UAC）：setup 建两账号；`--network enabled` 跑联网命令成功；`--network disabled` 跑命令成功但网络被 WFP 拦。
- **Bun 测试**：`resolveWindowsSandboxLevel` 不变。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 两账号密码管理 | 各自 DPAPI 文件 |
| 旧账号残留 | setup 后清理 |
| WFP 拦 offline 影响 | 仅 offline 账号 |
| 实机验证需 UAC | 交互终端跑 setup（已知限制） |

## 7. 实施顺序

- **P1**：account.zig 双账号 + 密码文件参数化。
- **P2**：setup.zig 建两账号 + offline WFP；main.zig `--network` 选账号。
- **P3**：收口验证（Zig + Bun + GapLoop + AttractorCheck）。