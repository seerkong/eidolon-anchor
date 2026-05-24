# 变更：收敛 AI-first 两层微内核的剩余 gap

## 背景和动机 (Context And Why)

当前仓库已经形成一版可工作的 AI-first 两层微内核雏形：

- 平台层已有 `platform-contract`、`platform-support`、`mod-platform-kernel`
- AI 领域层已有 `domain-ai-contract`、`domain-ai-logic`、`domain-ai-support`
- profile layering 已形成 `platform-only -> ai-kernel -> ai-coding`
- shell/runtime 已开始消费 assembly result 与 capability ports

但当前状态更接近“AI-first 架构已经成立、平台层仍偏薄且若干宿主仍停留在过渡态”，还没有达到“新 session 可直接按单一总 track 推进剩余 gap”的可执行状态。若不把剩余问题、非 blocker 结论、执行入口和停止条件整理成一个自包含的总 track，后续 session 仍需要重新回溯旧 archive、重新拼接上下文，执行成本过高。

本 track 的目标是把“两层微内核”的最终目标、剩余 gap、约束条件、实施顺序、验证基线与下一步执行入口整理为一个新的、自包含的执行入口，并将这些 gap 作为后续实现工作的正式追踪对象。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 将“两层微内核”定义为一版 AI-first 架构的正式最终目标
- 将当前剩余问题整理为可执行的成熟度 / 纯度 / 证据 gap
- 给出每类 gap 的边界、期望结果、实施顺序和 focused verification 基线
- 保持 track 自包含，不要求执行者依赖历史 archive 才能理解目标
- 保护现有 AI runtime 连续可运行，不引入大爆炸式重构
- 明确区分“当前两层微内核已成立”与“平台层已被充分验证”这两个不同结论
- 为新 session 提供可直接接棒的执行上下文与首轮切入点

**非目标:**
- 不在本 track 中直接完成所有代码迁移
- 不无证据创建 `platform-logic`
- 不要求一次性重命名 `core-*` / `organ-*` / `terminal-*` 的所有历史包
- 不以“结构对称”为理由将 AI 语义上收到平台层

## 变更内容（What Changes）

- 新建一个总括型 gap-closing track，作为后续新 session 的唯一执行入口
- 将剩余问题收敛为以下 5 类 gap / 治理缺口：
  - 平台 baseline 虽已存在，但仍偏薄，且仍带有少量历史 AI/runtime 依赖
  - `domain-ai-*` 已成为显式宿主，但真实真相源仍未充分收拢
  - shell bridge 仍偏厚，尚未收紧为更窄的 facade port consumer
  - 命名与类型外形仍持续泄露 AI 默认形状
  - 平台通用性仍缺少第二领域或真实重复实现证据
- 明确 `platform-logic` 不是当前 blocker，而是继续受 evidence gate 约束的后续候选层
- 为上述 gap 建立 proposal / spec / design / plan / analysis / context 基线

## 影响范围（Impact）

- 受影响的功能规范：
  - AI-first 两层微内核架构
  - 平台 profile layering 与 capability composition
  - 平台 baseline strength 与 platform evidence gate
  - AI domain host ownership
  - shell/runtime facade adoption
  - ownership leakage governance
- 预期受影响代码范围（后续实现时）：
  - `cell/packages/platform-*`
  - `cell/packages/domain-ai-*`
  - `cell/packages/composer`
  - `cell/packages/core-*`
  - `cell/packages/organ-*`
  - `terminal/packages/core`
  - `terminal/packages/organ`
  - `terminal/packages/tui`
