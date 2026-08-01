# 变更：平台微内核后续 sub-wave 的 support 与 mod 物理 rename

## 背景和动机

前四波已经完成：

- platform contract / composer contract / ownership 收口
- profile layering
- shell/runtime adoption
- 旧 profile alias cleanup

当前仍保留一个明确但非阻塞的结构性差距：目标命名结构尚未执行物理迁移。典型例子包括：

- `platform-support`
- `domain-ai-support`
- `mod-ai-kernel`
- `mod-ai-coding`

这不是前四波未完成，而是下一轮独立的结构迁移工作。为了避免继续长期保留“旧包名 + 新职责”的状态，需要单独开一个 sub-wave track 承接。

## 要做

- 拆分当前 `@cell/organ-support`，明确哪些实现属于 `platform-support`，哪些仍属于 `domain-ai-support`
- 将 `mod-sys-kernel` / `mod-sys-coding` 物理归位到 AI 命名
- 设计兼容迁移顺序，避免一次性大爆炸 rename
- 为后续真实代码切换准备 focused verification baseline

## 不做

- 本次不要求一步完成全仓所有 import path rename
- 本次不要求同步重命名 `core-* / organ-*` 全部包
- 本次不改变已稳定的 terminal/tui/headless 主路径行为

## 变更内容

- 固化 support 物理拆分策略
- 固化 mod 物理 rename 策略
- 规划兼容层与 cutover 顺序
- 形成新的实现计划，供下一轮实际代码迁移使用

## 影响范围

- 受影响代码：
  - `cell/packages/organ-support`
  - `cell/packages/mod-sys-kernel`
  - `cell/packages/mod-sys-coding`
  - 相关入口与测试
- 与现有 track 关系：
  - 承接 `refactor-platform-kernel-and-ai-domain-kernel`
  - 不回退前四波已完成的行为边界
