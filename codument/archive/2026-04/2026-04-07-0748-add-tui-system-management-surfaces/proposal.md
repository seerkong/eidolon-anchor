# 变更：添加 TUI 系统管理界面

## 背景

prototype 中与系统管理相关的 materials 已经分散沉淀，但仍缺少成体系的可见入口：

- session list / rename 素材已存在，但没有真正挂到当前主界面
- provider / model system materials 已就位，但用户仍缺少切换与管理入口
- agent 与 MCP 相关 materials 也尚未进入 prototype 的系统界面

如果把 session、provider/model、agent/MCP 继续拆成多个 track，既会重复构建 shared selection state，也会让 command palette 和 status/guidance 的前置面进一步碎片化。

## 合并来源

- `add-tui-session-switcher-surface`
- `add-tui-provider-and-model-surface`
- `add-tui-agent-and-mcp-system-surface`

## 变更内容

- 接入 session list / rename 等 system materials，并提供可触发的 session switcher surface
- 接入 provider / model system materials，提供 provider 浏览、连接和 model 切换入口
- 接入 agent 选择界面与 MCP 管理界面
- 让这些 system materials 与当前选择态和 runtime 状态联动

## 影响范围

- 受影响的规范：`terminal-tui-shell`
- 受影响的代码：system surface、session list、session rename、provider/model dialogs、agent dialog、MCP dialog、graph 中的 session/provider/model/current selection view state

## 顺序依赖关系

- 建议序号：`4`
- 建议前置：
  - `add-tui-input-and-material-state-foundations`
- 建议后续：
  - `add-tui-command-palette-surface`
  - `polish-tui-status-and-guidance-surface`
- 说明：session、provider/model、agent/MCP 都依赖共享状态层收敛后的统一选择态，合并后可以作为一组 system management surfaces 一次接入
