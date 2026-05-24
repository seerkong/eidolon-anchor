## 上下文
本项目已有 local permission runtime 和 exec metadata，但 Bash 执行仍直接调用子进程。参考 Sparrow，应将 sandbox 作为 backend/runtime 能力，而不是嵌入单个工具。参考 Codex，应在 macOS backend 内固定使用 `/usr/bin/sandbox-exec`，并生成 deny-by-default Seatbelt profile。

## 方案概览
1. 新增 sandbox backend runtime
   - `SandboxBackendSelection` 描述 backend、sandbox mode、network access、writable roots。
   - `resolveSandboxBackendSelection` 从 `runtime.vm.outerCtx.metadata` 解析当前执行策略。
   - `executeSandboxedBashCommand` 作为 Bash 工具统一入口。
2. 新增 macOS Seatbelt backend
   - `createMacOsSeatbeltPolicy` 生成 policy 文本。
   - `createMacOsSeatbeltCommand` 生成 `/usr/bin/sandbox-exec -p <policy> -- <shell> -lc <command>`。
   - policy 默认 deny，允许必要 process/sysctl/tty/dev-null，允许读取，按 mode 限制写入。
   - `network_access=enabled` 时添加网络 allow；disabled 时不添加。
3. 保持权限链顺序
   - Bash tool 先调用 `authorizeLocalToolCall`。
   - 通过后再解析 sandbox selection 并执行。
   - `danger-full-access` 显式走 unsandboxed。

## 影响范围与修改点（Impact）
- `cell/packages/ai-organ-logic/src/sandbox/SandboxBackendRuntime.ts`
- `cell/packages/ai-organ-logic/src/sandbox/MacOsSeatbeltSandbox.ts`
- `cell/packages/ai-organ-logic/src/sandbox/index.ts`
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Bash/Logic.ts`
- `cell/packages/ai-organ-logic/tests/AIAgent/sandbox_backend_runtime.test.ts`

## 决策摘要
- 采用 Sparrow 的 backend/runtime 抽象作为主架构。
- macOS backend 采用 Codex 的关键实践：固定绝对路径调用 `sandbox-exec`，deny-by-default，使用参数化路径，保护元数据目录。
- 非 macOS 暂时兼容回落到现有子进程执行，由 local permission runtime 继续兜底。
- 提交模式为 manual；校验模式为 yield-gap-loop；仅最后 phase 后执行 gap-loop。

## 风险 / 权衡
- 风险：Seatbelt policy 过窄会阻断常见命令。缓解：保留必要系统读取、TTY、`/dev/null` 和 TMP 写入。
- 风险：非 macOS 无真实 sandbox。缓解：抽象已建立，后续可新增 Linux/Windows backend；当前不改变原行为。
- 风险：直接对所有工具套 sandbox 可能影响大。缓解：本次只接入 Bash，后续再扩展。

## 兼容性设计
- `danger-full-access` 不使用 sandbox。
- 缺失或未知 sandbox mode 默认按 `workspace-write` 处理。
- 非 macOS 使用 unsandboxed fallback，不破坏现有测试和开发环境。

## 迁移计划
1. 新增 backend runtime 与 macOS backend。
2. Bash 工具切换到 runtime 执行。
3. 用测试覆盖生成的 command args，不要求测试环境真实运行 macOS Seatbelt。
4. 后续 track 可扩展到文件工具和 Linux backend。

## 待解决问题
- 是否把 file tools 也统一纳入 sandbox backend。
- 是否增加 Linux bubblewrap backend。
- 是否将 sandbox denial 接入 approval retry 主链。
