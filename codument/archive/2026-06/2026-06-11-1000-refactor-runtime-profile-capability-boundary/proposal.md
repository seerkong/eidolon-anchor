# 变更：重构 Runtime Profile Capability Boundary

## 背景和动机 (Context And Why)

TUI、CLI、headless 当前已经共享部分 runtime bridge，但真实运行问题仍反复暴露 surface 差异、session load 差异、storage 开关与 upgrade 入口分散等问题。根据双层微内核方向，Product Surface 不应手工拼默认 AI 业务语义；entry 应只选择 profile，由 profile/capability/runtime binding 统一组合 runtime。

本 track 的目标是建立扩展面的硬边界：统一 CLI/TUI/headless 的 profile composition path，并把 storage logs/files、upgrade、work context 等能力通过 capability 显式表达。

## “要做”和“不做” (Goals / Non-Goals)

目标：

- 定义 runtime profile、capability registry、runtime binding descriptor contract。
- 统一 CLI/TUI/headless 创建 runtime 的 composition path。
- 确保 product surface 只选择 profile，不直接定义 AI domain truth。
- 将 storage `logs` / `files` 能力作为 profile/capability flags。
- 添加三入口一致性 tests 和 surface no-domain-write tests。

非目标：

- 不迁移 conversation persistence。
- 不拆 executor。
- 不修改 provider/tool lifecycle。
- 不处理 DataSubgraphContract 以外的数据 owner。
- 不修复或升级历史 session。

## 变更内容（What Changes）

- 新增或收敛 runtime profile/capability contract。
- 新增 runtime binding descriptor，用于比较 CLI/TUI/headless composition。
- 收敛 terminal entry：entry 选择 profile，profile 决定 runtime capabilities。
- 添加 memory-only / persistent / logs / files capability tests。
- 添加 surface entry 不写 domain truth 的 conformance tests。

## 影响范围（Impact）

- 受影响的功能规范：`runtime-profile-capability-boundary`。
- 可能影响的代码区域：
  - `cell/packages/mod-profiles`（现有 profile 组合包，profile contract 的首选宿主）
  - `cell/packages/ai-composer`（现有 runtime 组合路径）
  - `cell/packages/mod-platform-kernel`
  - `cell/packages/mod-ai-kernel`
  - `cell/packages/mod-ai-coding`
  - `cell/packages/ai-core-contract`
  - `terminal/packages/organ`
  - `terminal/packages/tui`
  - `terminal/packages/cli`
  - `terminal/packages/organ-support`
