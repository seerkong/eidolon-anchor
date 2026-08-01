# 变更：重组 TUI 子包模块结构

## 背景和动机 (Context And Why)
`terminal/packages/tui/src` 经过多轮功能迁移后出现目录层次深、命名语义泛、入口/runtime/UI/具体 app 混杂的问题。当前还有 `materials` 目录、宽泛 import alias、深层相对路径、以及可能未实际启用的功能代码。此次重构目标是让 TUI 子包结构贴合 `terminal/packages` 的模块拆分理念，并为未来其他 TUI 变种留出清晰空间。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 按模块关系重组 `terminal/packages/tui/src`。
- 保留 TuiA1 作为当前具体 TUI 变种，并让其与通用 UI、provider、runtime adapter 分层。
- 拆分过大的 TuiA1 root/orchestration 文件。
- 建立并执行未使用或未启用功能的清单流程，例如 LSP。
- 最终移除 TUI-local import alias 和迁移兼容代码。
- 保持现有 TUI 行为稳定。

**非目标:**
- 不重新设计 TUI 视觉样式。
- 不改变用户可见功能语义。
- 不主动创建新的 TUI 变种。
- 不在第一阶段强行跨 package 抽离 runtime facade，除非发现必须修复的包边界问题。

## 变更内容（What Changes）
- 新建责任清晰的目录层次：entry、runtime、app/tui_a1、ui、providers、commands、support、types。
- 将 `tui_a1/materials` 和 feature 内部 `materials` 重命名或迁移到更明确的 feature/provider/state/logic 目录。
- 将通用 dialog、primitive、toast、selection 等 UI 代码集中到 reusable UI 区域。
- 将启动入口和 CLI glue 收敛到 entry 区域。
- 将 runtime adapter 代码与 UI/app 代码分离。
- 建立 unused-feature inventory，并对 LSP 等疑似未启用功能形成保留/删除决策。
- 移除 `@tui/*`、`@/*` 等 TUI-local alias 用法，最终不保留兼容 re-export。

## 影响范围（Impact）
- 受影响的功能规范：TUI 模块结构、TUI 启动入口、TUI runtime adapter、TUI dialog/session/message/composer 功能。
- 受影响的代码：`terminal/packages/tui/src`、`terminal/packages/tui/tsconfig.json`、`terminal/packages/tui/package.json`、必要时 `terminal/packages/organ-support` export 边界。
