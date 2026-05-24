# 变更：实施平台微内核 Wave 1 的 contract、composer 与 ownership 收口

## 背景和动机

当前仓库已经完成“平台微内核 + AI 领域微内核”的设计基线讨论，并冻结了以下方向：

- 平台微内核只承载跨领域可复用的执行平台能力
- AI 领域语义继续留在 AI 领域内核
- `@cell/composer` 应提升为平台级 capability composition contract
- `AiAgentVm` 与 `core-contract` 需要把 AI-shaped ownership 从平台边界中迁出
- 第一批实施波次应先处理 contract / composer / ownership tables，而不是直接做 profile 或 shell 大规模 cutover

本 track 承接该实施路线中的 **Wave 1**，目标是先建立新的正式真相源，避免后续 profile、shell 与物理包迁移继续建立在 AI-shaped contract 之上。

## 要做

- 为平台执行内核建立第一版正式 contract 边界
- 为 `@cell/composer` 建立平台级 composition contract，并明确 AI domain assembly facet 的位置
- 产出正式 ownership tables，明确哪些 contract / state / package 目标迁往平台层，哪些保留在 AI domain
- 用 focused tests 或等价验证，锁定 composer contract ownership 与 AI-shaped surface 的退出方向

## 不做

- 本次不引入 `platform-only` profile 的正式 cutover
- 本次不处理 terminal / tui / headless 的 runtime adoption cutover
- 本次不执行大规模物理包 rename
- 本次不处理 AI 领域 support 的全面迁移

## 变更内容

- 新增或重构第一版 platform contract
- 调整 `@cell/composer` contract，使其不再默认直接依赖 AI-shaped surface
- 沉淀一套正式 ownership tables，作为后续 wave 的唯一边界基线
- 通过 focused verification 保护：
  - platform contract ownership
  - composer contract ownership
  - AI-shaped contract 的迁出方向

## 影响范围

- 受影响代码：
  - `cell/packages/core-contract`
  - `cell/packages/core-logic`
  - `cell/packages/composer`
  - `cell/packages/mod-profiles`
  - 相关 focused tests
- 后续波次依赖：
  - platform profile layering
  - shell/runtime entry adoption
  - package cleanup
