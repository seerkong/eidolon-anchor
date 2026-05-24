# TUI 滚动问题排查

本页记录 terminal TUI 中“滚动时掉到 shell scrollback，而不是停留在 TUI 内部”的问题背景与当前修复思路。

## 现象

在 terminal TUI 中使用滚轮 / 触控板滚动时：

- 预期：只滚动当前 TUI 的会话历史
- 实际：终端开始显示进入 TUI 之前的 shell 历史

这说明问题更偏向：

- terminal mode / renderer startup
- 而不是 session 页面内部的 `scrollbox` 组件本身

## 当前判断

近期 member / collective / formation / protocol 的 runtime 改动，主要影响：

- 事件流
- slash 命令
- actor runtime
- member / organization UX

它们不直接修改 TUI renderer 的底层启动方式。

从代码对比看，真正更可能影响“滚动会不会掉到 shell scrollback”的位置是：

- `terminal/packages/tui/src/cli/cmd/tui/app.tsx`

## 修复策略

当前实现采取的策略是：

- 参考 opencode 的整体 TUI 启动链路
- 但在本项目中进一步显式拥有 terminal surface：
  - 进入 alternate screen
  - 打开 mouse tracking
  - 打开 SGR mouse encoding
- 退出时再恢复这些 terminal modes

目前对齐项包括：

- `exitOnCtrlC: false`
- `useMouse: true`
- 显式写入：
  - `\x1b[?1049h`
  - `\x1b[?1000h`
  - `\x1b[?1002h`
  - `\x1b[?1003h`
  - `\x1b[?1006h`
- 挂载后周期性重申这些 terminal modes，避免被 renderer / shell integration 覆盖

## 为什么这样做

因为 opencode 的 TUI 与本项目使用相同的 opentui 技术栈与相近的 session/scrollbox 结构。

如果滚动问题来自 renderer startup 配置或 terminal mode ownership，那么：

- 优先对齐已验证配置
- 并在本项目中补上显式 terminal mode 控制，比继续猜测 renderer 默认值更稳妥
- 如果单次设置仍可能被覆盖，则继续采用 guard interval 周期性重申，直到 TUI 退出

## 仍需实机确认

这类问题具有终端环境相关性，和如下因素有关：

- iTerm2 / Terminal.app / Kitty / Warp
- shell integration
- scrollback 配置
- alternate screen 行为

因此即使代码已对齐，也仍需要在真实终端中再次验证。

## 建议验证步骤

1. 启动 TUI
2. 进入一个包含较长历史的 session
3. 用滚轮或触控板滚动
4. 观察：
   - 是否只滚动当前 TUI
   - 是否仍出现 shell scrollback

## 如果问题仍然存在

下一步应继续做：

- renderer-level 终端模式排查
- 基于 `mockMouse.scroll(...)` 的更细粒度 e2e
- 对比 opentui renderer 在本项目与 opencode 中的真实初始化链路差异
