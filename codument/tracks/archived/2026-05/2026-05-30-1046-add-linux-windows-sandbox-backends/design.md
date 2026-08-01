## 上下文
本项目已有 `SandboxBackendRuntime`、`MacOsSeatbeltSandbox`、Bash 工具接入和聚焦测试。现有 runtime 已经把 `sandbox_permissions` 元数据转换为 backend selection，并将 macOS `read-only` / `workspace-write` 包装成 Seatbelt 执行；非 macOS 当前会回落到 unsandboxed。用户要求参考 Codex Windows Elevated sandbox 和 Linux sandbox 的实现原理，基于相同扩展机制实现 Windows 和 Linux sandbox。

## 方案概览
1. 扩展 backend selection
   - 将 `SandboxBackendName` 从 `macos-seatbelt | unsandboxed` 扩展为包含 `linux-bwrap` 与 `windows-elevated`。
   - `danger-full-access` 在所有平台继续选择 `unsandboxed`。
   - `read-only` / `workspace-write` 在 Linux 和 Windows 上选择平台 backend；依赖缺失或 setup 不完整时 fail closed。
   - 复用现有 writable roots 解析，包括 workspace root、additional writable roots 和 workspace-access grants。

2. 新增 Linux backend 模块
   - 建议模块：`LinuxSandbox.ts`。
   - 提供 command builder：把 Bash command 转换为 helper/bwrap 风格执行参数。
   - 语义对齐 Codex：只读根、显式 writable roots、保护 metadata subpaths、network disabled 时隔离/阻断网络、WSL1 或 user namespace 不可用时报错。
   - 初始实现可先分离 dependency detection、command args builder、execution dispatcher，再用平台 gated smoke test 验证真实写入/拒绝。
   - 对 `network_access=disabled` fail closed，除非当前实现能实际隔离网络。

3. 新增 Windows backend 模块
   - 建议模块：`WindowsSandbox.ts`。
   - 提供 setup readiness / command runner adapter：表达 elevated setup、sandbox identity、ACL/capability SID、runner IPC 所需输入。
   - 语义对齐 Codex：read-only 使用只读 capability，workspace-write 使用 writable-root capability，protected metadata 需要显式 deny 或保护规则。
   - setup 未完成、权限不足、网络过滤不可用时返回明确错误，不进入 unsandboxed。
   - 真实 Windows smoke test 通过 platform gate 运行；非 Windows 单元测试覆盖 selection、planner 和错误路径。

4. 分派执行路径
   - `executeSandboxedBashCommand` 与 streaming variant 按 `backendName` 分派。
   - 保持 macOS path 原样。
   - 保持 sync path 可注入 `spawnSyncFn` 以便单元测试。
   - streaming path 增加可测试的 spawn spec builder 或 backend runner abstraction，减少平台分支难测问题。

5. 测试策略
   - 红色阶段先补失败测试：Linux/Windows selection 不再 unsandboxed，Linux/Windows command builder 生成预期 args，unsupported dependency fail closed，Bash delegation 使用对应 backend。
   - 绿色阶段实现最小分派与 backend 模块。
   - 平台 smoke：Linux 测试 read-only write denial、workspace write allow/deny、network disabled；Windows 测试 setup error、read-only/write behavior、workspace-write allow/deny。

## 影响范围与修改点（Impact）
- `cell/packages/ai-organ-logic/src/sandbox/SandboxBackendRuntime.ts`
- `cell/packages/ai-organ-logic/src/sandbox/MacOsSeatbeltSandbox.ts`
- `cell/packages/ai-organ-logic/src/sandbox/index.ts`
- `cell/packages/ai-organ-logic/src/sandbox/LinuxSandbox.ts`
- `cell/packages/ai-organ-logic/src/sandbox/WindowsSandbox.ts`
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Bash/Logic.ts`
- `cell/packages/ai-organ-logic/tests/AIAgent/sandbox_backend_runtime.test.ts`

## 决策摘要
- 详见 `codument/tracks/add-linux-windows-sandbox-backends/decisions.md`
- 当前关键结论：使用现有 sandbox backend runtime 作为唯一扩展点；Linux/Windows 不可用时 fail closed；提交模式为 manual；校验模式为 final-phase gap loop。

## 风险 / 权衡
- 风险：直接完整移植 Codex Linux/Windows sandbox 成本高。缓解措施：先实现清晰 backend contract、dependency/setup 检查和 command planner，再补目标平台 smoke。
- 风险：Linux `bwrap`、user namespace、WSL1、container 环境差异导致可用性不稳定。缓解措施：显式检测并返回 actionable error。
- 风险：Windows elevated setup 涉及管理员权限和持久 ACL，容易影响宿主机状态。缓解措施：setup/readiness 独立建模，真实修改只在明确 setup 流程中进行，并用平台 gated 测试。
- 风险：网络限制如果实现不完整会产生安全错觉。缓解措施：`network_access=disabled` 在能力不足时 fail closed。
- 风险：macOS 回归。缓解措施：保持 macOS backend 模块接口不变并运行现有聚焦测试。

## 兼容性设计
- `danger-full-access` 保持 unsandboxed。
- Bash tool input/output shape 不变。
- macOS `macos-seatbelt` 行为不变。
- Linux/Windows 以前的隐式 unsandboxed fallback 改为 sandbox backend 或明确错误；这是安全语义收紧，不是 API 破坏。

## 迁移计划
1. 添加失败测试并确认当前 Linux/Windows selection 会失败。
2. 扩展 backend type、selection 和 dispatcher。
3. 实现 Linux backend dependency detection、command builder 和 execution path。
4. 实现 Windows backend readiness、command planner 和 execution/error path。
5. 补充 Bash integration 测试和平台 gated smoke tests。
6. 运行聚焦测试，必要时在目标平台补跑 smoke。

## 待解决问题
- 是否打包 Linux/Windows helper，还是只依赖系统/外部 helper。
- Windows elevated setup 是否在本 track 内完全落地。
- 是否在后续 track 把文件编辑类工具也接入 sandbox backend。
