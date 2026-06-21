# 变更：统一 TUI Dialog 风格

## 背景和动机 (Context And Why)
近期 TUI 已围绕 Sessions 弹窗建立了新的弹窗视觉和交互标准，包括 OpenTUI 内置边框、紧凑布局、方括号可点击动作、稳定单行截断和真实数据同步。当前仍有多个 shared dialog primitive 和 custom dialog 未统一，导致边框、留白、按钮文案、搜索区、hover/focus 颜色、列表密度和操作刷新行为不一致。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 将剩余 TUI dialog 统一到 `terminal/docs/standard/uiux/dialog.md` 记录的规范。
- 优先改造 shared dialog primitives，让 command/model/provider/agent/MCP/theme 等选择类弹窗自动继承统一样式。
- 迁移 file picker、shortcuts、status、provider auth 等自定义弹窗。
- 保持 Sessions 弹窗作为特殊密集列表参考实现，并确保删除、重命名、分叉等操作持久生效。
- 补充关键交互验证，覆盖关闭、搜索清空、hover/focus、长文本截断和数据刷新。

**非目标:**
- 不重写 TUI 整体布局系统。
- 不改变 dialog 背后的业务模型、命令语义或 provider 授权流程。
- 不引入新的 UI 框架或替换 OpenTUI。
- 不做与弹窗统一无关的主题大改。

## 变更内容（What Changes）
- 标准化 `DialogHeader`、`DialogSelect`、`DialogAlert`、`DialogConfirm`、`DialogPrompt` 等 shared primitive。
- 统一可点击动作文案为 bracketed label，例如 `[关闭(esc)]`、`[取消]`、`[确认]`、`[清空]`。
- 统一列表弹窗的搜索区、清空按钮、滚动区域填充、footer anchoring、hover/focus 色彩和单行截断。
- 迁移 file picker、shortcuts、status、provider auth 相关 custom dialog。
- 保留 Sessions dialog 的特殊密集布局，并纳入数据持久化/刷新验证。
- **BREAKING**: 无预期破坏性变更；该 track 仅调整 TUI 视觉和交互一致性。

## 影响范围（Impact）
- 受影响的功能规范：`terminal-tui-shell`
- 受影响的主要代码：
  - `terminal/packages/tui/src/cli/cmd/tui/ui/dialog.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/ui/dialog-select.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/ui/dialog-alert.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/ui/dialog-confirm.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/ui/dialog-prompt.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/file-picker-dialog.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/system/shortcuts/shortcuts-dialog.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/system/status/status-dialog.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/system/provider/provider-dialog.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/system/session/session-list-dialog.tsx`
