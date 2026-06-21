# 变更：添加 TUI 命令面板界面

## 背景和动机

当前仓库里已经有 `dialog-command.tsx`、`command/catalog.ts` 和 `command_list` 快捷键约定，但新的 prototype shell 还没有把这些底件真正挂成统一的 command palette surface。结果是：

- system materials 虽然逐步沉淀，却缺少一个统一入口
- 快捷键直达、slash command、dialog surface 之间没有共用的动作注册层
- prototype 入口目前也没有明确挂载 `CommandProvider` 这类 palette host

这个 track 的目标不是重新发明命令系统，而是把已有的 command dialog 和 command catalog 收敛成 prototype-first TUI 可直接使用的统一入口。

## “要做”和“不做”

**目标:**

- 在 prototype shell 中挂载 command palette host
- 汇总 system materials 和常用动作为 palette 可触发项
- 让 palette 触发与快捷键直达复用同一套 handler / action registration
- 让 command palette 成为新的 system surfaces 统一入口之一

**非目标:**

- 本 track 不重做 slash command 语法或 command catalog 的整体语义
- 本 track 不负责一次性实现所有 system surfaces，本 track 只负责把已存在素材接入统一入口
- 本 track 不把 command palette 做成第二套平行状态系统
- 本 track 不承担 status/tips/help 文案 polish

## 变更内容

- 在 prototype 入口接入 command palette 所需的 provider / host
- 为 session、provider/model、agent、MCP、status、help 等动作建立 palette registration
- 汇总快捷键、命令标题、建议动作和筛选能力
- 确保 palette 触发与快捷键触发不会行为分叉

## 影响范围

- 受影响的规范：`terminal-tui-shell`
- 受影响的代码：
  - `terminal/packages/tui/src/cli/cmd/tui/component/dialog-command.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/command/catalog.ts`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/index.tsx`
  - prototype system materials 入口与相关 dialog components

## 顺序依赖关系

- 建议序号：`11`
- 建议前置：
  - `add-tui-input-and-material-state-foundations`
  - `add-tui-system-management-surfaces`
- 建议后续：
  - `polish-tui-status-and-guidance-surface`
- 说明：command palette 更适合作为统一入口层，在主要 action surfaces 出现后再汇总，避免先做一个空壳入口
