# Design: Standardize TUI Dialogs

## Context
Sessions dialog 已经形成当前 TUI dialog 的目标体验：内置边框、极致紧凑但可读的内容布局、方括号按钮、稳定单行截断、底部关闭动作和真实数据刷新。剩余 dialog 分散在 shared primitive 与 custom implementation 中，应该以 shared primitive 优先的方式统一。

## Approach
1. 先审计 dialog 调用点，确认哪些直接使用 shared primitive，哪些是 custom dialog。
2. 先改 shared primitive：
   - `dialog.tsx` 负责 shell/header/footer/common spacing。
   - `dialog-select.tsx` 负责列表、搜索、清空、hover/focus、滚动区填充和单行截断。
   - `dialog-alert.tsx`、`dialog-confirm.tsx`、`dialog-prompt.tsx` 负责非列表类 dialog 的 bracketed actions 和标准 shell。
3. 再迁移 custom dialog：
   - File picker 作为文件列表类 dialog。
   - Shortcuts/status 作为 information dialog。
   - Provider OAuth/API key 子弹窗作为 information/form dialog。
4. 最后复查 Sessions dialog，确保它继续满足 specialized dense list 规范，并补齐数据操作验证。

## Dialog Categories
- **普通列表类**：command、model、provider、agent、MCP、theme 等通过 `DialogSelect` 覆盖。
- **密集列表类**：Sessions dialog，三行记录结构，极致紧凑，数据操作必须持久生效。
- **表单类**：prompt、rename、API key 输入等，需标准边框、稳定输入区、bracketed confirm/cancel。
- **确认类**：delete/quit/危险操作确认，需 `[取消]` 和 `[确认]` 或具体 bracketed verb。
- **信息类**：shortcuts、status、provider auth info，需标准边框、可滚动内容和标准 close action。

## Key Decisions
- 使用 OpenTUI 内置 border 能力，不手绘边框。
- Clickable action 一律用 bracketed label 表示。
- 列表内容默认单行截断，不通过换行增加行高。
- Dialog list body 应填充剩余高度，footer/close row 应锚定在规范位置，避免大块空白。
- Sessions dialog 是特殊密集列表，不强制套用普通列表的宽松留白。

## Risks And Mitigations
- **风险：shared primitive 改动影响面大。** 通过先补 focused tests 和运行关键 TUI test 降低回归风险。
- **风险：终端宽度较小时按钮和右侧时间重叠。** 使用宽度预算、优先截断左侧文本、保留右侧 metadata/action。
- **风险：hover/focus 颜色在不同主题下不可读。** 选用主题中已有高对比色，并在暗色/亮色状态下检查。
- **风险：custom dialog 行为被视觉迁移破坏。** 每个 custom dialog 迁移后保留原有键盘和点击语义。

## Verification
- 运行与 TUI dialog 相关的单元测试或 focused tests。
- 使用 `dev:terminal:cli` 或现有 TUI 启动方式手动打开关键 dialog：
  - Sessions
  - 使用说明 / Keyboard Shortcuts
  - 功能菜单 / Slash Commands
  - Model/Provider/Agent/MCP/Theme select
  - File picker
  - Status
  - Provider auth/API key
- 验证 Escape、`[关闭(esc)]`、搜索 `[清空]`、hover/focus、滚动、长文本截断和数据操作刷新。

## Non-Goals
- 不重构 OpenTUI 底层组件。
- 不改变 provider、model、session、command 的业务数据结构。
- 不替换主题系统。
