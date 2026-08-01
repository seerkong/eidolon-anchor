# 变更：实施平台微内核 Wave 2 的 profile layering

## 背景和动机

Wave 1 已经完成 platform contract、composer contract 与 ownership tables 的正式收口。下一步必须把运行时 profile 从“单个默认 profile”提升为显式分层模型，否则 shell/runtime entry 仍然只能依赖隐式默认组合，无法形成稳定的平台基线、AI 领域基线与 app overlay 顺序。

本 track 承接微内核迁移路线中的 **Wave 2**，目标是在不打断当前 terminal/tui/headless 主路径的前提下，建立正式的三层 profile：

- `platform-only`
- `ai-kernel`
- `ai-coding`

## 要做

- 在 `@cell/mod-profiles` 中建立正式的三层 profile layering
- 让现有 coding runtime 通过 `ai-coding` 正式入口装配
- 保留最小兼容别名，避免一次性打断现有调用方
- 补 focused tests，锁定：
  - profile order
  - capability absence
  - runtime adoption continuity

## 不做

- 本次不处理 terminal/tui/headless 的全面 shell adoption cutover
- 本次不处理 support 的平台/AI 物理拆分
- 本次不执行物理包 rename 或旧路径清理
- 本次不把非主 runtime 调用方全部切到 assembly result

## 变更内容

- 新增 `platform-only`、`ai-kernel`、`ai-coding` 三个正式 profile
- 用单一 truth source 定义 profile 叠加顺序
- 将当前默认 coding runtime 装配收口到 `ai-coding`
- 对旧的 `default-coding` 入口保留兼容别名

## 影响范围

- 受影响代码：
  - `cell/packages/mod-profiles`
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
  - runtime/profile focused tests
- 后续波次依赖：
  - Wave 3 shell/runtime entry adoption
  - Wave 4 package cleanup
