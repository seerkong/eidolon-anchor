# 变更：双账号 Windows 沙箱（每次命令可选网络策略）

## 背景和动机 (Context And Why)

`implement-windows-sandbox-account` 实现了单账号（`eidolon-sandbox`）+ 一次性 `--network disabled` 决定是否装 WFP 过滤器。但这是**账号级、一次性的**：setup 时装了过滤器，账号永远离线；不装，永远在线。无法"每次命令根据安全需求选不同网络策略"。

独立账号方案用**双账号**：
- **online 账号**（能联网）
- **offline 账号**（WFP 拦截出站）

每次 bash 命令根据 `--network` flag **选择用哪个账号运行**——这才实现"每次可选"。

## 要做 / 不做

**目标：**

- setup 创建两个账号：`eidolon-sandbox-online`（联网）+ `eidolon-sandbox-offline`（WFP 拦截）。
- 两个账号密码各自 DPAPI 加密存 `account-password-online.bin` / `account-password-offline.bin`。
- WFP 过滤器只装 offline 账号（`--network disabled` 语义固定到 offline 账号）。
- runner 按 `--network` 选账号：enabled → online 账号，disabled → offline 账号。`--network` 参数真正生效（不再是死参数）。
- 保持向后兼容：`eidolon-sandbox` 旧账号可清理（升级路径）。

**非目标：**

- 不做跨平台。
- 不改变 disabled（未 setup）降级路径。
- 不迁移历史 session。

## 变更内容

- `account.zig`：双账号名 + 各自密码文件；`createSandboxAccount(name)` 参数化。
- `setup.zig`：建 online + offline 两账号；offline 装 WFP。
- `main.zig`：`--network` 选账号登录（online/offline）。
- `SandboxBackendRuntime.ts`：无需改（已传 --network）。

## 影响

- 能力：`windows-sandbox-dual-account`
- 代码：windows-sandbox-runner 的 account/setup/main.zig
- 兼容：单账号 `eidolon-sandbox` 可保留或清理；未 setup 降级不变。