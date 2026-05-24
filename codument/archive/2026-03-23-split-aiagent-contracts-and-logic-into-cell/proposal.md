# 变更：将 AIAgent 契约与逻辑拆分迁移到 cell 包层

## 背景和动机 (Context And Why)
当前 AIAgent 相关代码主要堆叠在 `backend/packages/core/src/modules/AIAgent` 与 `backend/packages/organ/src/AIAgent` 中，契约定义、底层引擎约束、领域协议、运行时逻辑、组织逻辑、流处理与适配器实现混杂在一起。随着仓库已经引入新的 `cell/packages/*` 多包结构，需要把 AIAgent 领域重新按依赖层次拆分，使包边界能够真实表达领域职责，并为后续独立演进、复用与测试提供稳定基础。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 将 `backend/packages/core/src/modules/AIAgent` 中的契约类迁移到 `cell/packages/core-contract`
- 将 `backend/packages/core/src/modules/AIAgent` 中的逻辑迁移到 `cell/packages/core-logic`
- 将 `backend/packages/organ/src/AIAgent` 中不依赖未来 `core-contract` 的底层契约迁移到 `cell/packages/organ-contract-low`
- 将 `backend/packages/organ/src/AIAgent` 中去除 `organ-contract-low` 后的契约层内容迁移到 `cell/packages/organ-contract-high`
- 将 `backend/packages/organ/src/AIAgent` 中拆分后剩余逻辑迁移到 `cell/packages/organ-logic`
- 一次性将仓库内调用方切换到 `@cell/*`，不保留旧路径兼容层
- 重建新的导出面与依赖关系，使 `cell` 成为 AIAgent 领域的唯一正式来源

**非目标:**
- 不新增 shell 包或新的产品入口
- 不保留 `@backend/core/modules/AIAgent` 或 `@backend/organ/AIAgent` 的长期兼容层
- 不在本次重构中引入新的 AIAgent 产品能力
- 不将旧目录结构原样镜像复制到 `cell`

## 变更内容（What Changes）
- 将现有 AIAgent 代码按依赖层级重新分配到 `@cell/core-contract`、`@cell/core-logic`、`@cell/organ-contract-low`、`@cell/organ-contract-high`、`@cell/organ-logic`
- 按“底层引擎契约 -> AIAgent 核心契约 -> 高层组织契约 -> 逻辑实现”的依赖方向重建包关系
- 识别并下沉 stream 相关的底层契约到 `organ-contract-low`
- 重新设计新包的 `exports`、TypeScript 路径与 workspace 依赖
- 全量改写仓库内相关 imports，包括 `backend`、`terminal`、测试代码及其他直接调用方
- 删除旧路径作为正式源头的角色，不保留 re-export 兼容层
- **BREAKING**：AIAgent 相关模块路径与导入方式将整体切换到 `@cell/*`

## 影响范围（Impact）
- 受影响的功能规范：AIAgent 领域契约、runtime、stream、protocol、organization、llm、mcp、plan、persistence、tool composition
- 受影响的代码：
  - `backend/packages/core/src/modules/AIAgent/**/*`
  - `backend/packages/organ/src/AIAgent/**/*`
  - `backend/packages/composer/src/modules/AIAgent/**/*`
  - `terminal/packages/organ/src/AIAgent/**/*`
  - `terminal/packages/tui/src/runtime/**/*`
  - `backend/packages/organ/tests/AIAgent/**/*`
  - 仓库内所有直接引用旧 AIAgent 路径的调用方与测试
