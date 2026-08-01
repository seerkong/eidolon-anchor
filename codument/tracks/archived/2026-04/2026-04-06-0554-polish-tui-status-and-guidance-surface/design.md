# Design: polish-tui-status-and-guidance-surface

## 目标

将 prototype 中分散存在的底栏状态、busy beacon、status dialog、help/tips 收敛成一致、可信且与真实能力同步的状态与指引 surface。

## 当前现状

### 1. 状态与指引素材已经存在，但还比较分散

- `terminal/packages/tui/src/cli/cmd/tui/prototype/bottom-bar.tsx`
  - 已有双侧扫描式底栏信标
  - 已展示 selection 与 message count
  - busy 时仍存在较硬编码的 `streaming local response` 文案
- `terminal/packages/tui/src/cli/cmd/tui/component/prompt/busy-beacon.tsx`
  - 已有更通用的 `BusyBeacon`
  - 支持 `busy / retry / idle / error / aborted`
  - 当前底栏并未复用这个组件
- `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/system/status/status-dialog.tsx`
  - 已有状态对话框
  - 可显示 MCP / LSP / formatter / plugin 状态
- `terminal/packages/tui/src/cli/cmd/tui/ui/dialog-help.tsx`
  - 已有帮助对话框
- `terminal/packages/tui/src/cli/cmd/tui/component/tips.tsx`
  - 已沉淀大量 tips 文案
  - 当前没有被 prototype 主链真正使用

结论：本 track 是“收敛和打磨”，不是“从无到有”。

### 2. 当前状态语言还不够统一

几个明显问题：

- 底栏自己的扫描条实现与通用 `BusyBeacon` 分裂
- busy 文案仍偏原型期硬编码，不一定对应真实 runtime 状态
- tips 文案库存很大，但包含大量并非当前 prototype 一定可见、可证实的能力提示

结论：真正的 gap 在“状态语言一致性”和“指引内容可信度”。

### 3. status surface 已接入 palette，但还不是最终 polish 形态

- `prototype/command-palette.tsx` 已把 `DialogStatus` 和 `DialogHelp` 接入 command palette

这意味着本 track 不需要先解决入口问题，而是要解决内容质量和一致性问题。

## 约束

- 本 track 默认建立在 command palette 与主要 system surfaces 已可用的前提上
- tips/help 不应继续暴露已删除旧 shell 的入口或不再成立的能力
- 状态层应尽量复用现有组件，而不是再做一套新的指示器体系

## 目标方案

### 1. 底栏 busy language 与通用 beacon 统一

建议重新审视底栏：

- 能否改为复用 `BusyBeacon`
- 或至少与 `BusyBeacon` 的状态语义对齐

关键点：

- busy / idle / retry / error 等状态在底栏和状态界面中的表达要一致
- busy 文案不再停留在“local prototype reply”阶段措辞

### 2. status dialog 作为“系统事实面”，底栏作为“轻量状态摘要”

职责建议：

- 底栏：只做轻量、持续可见的状态摘要
- status dialog：承载更完整的系统状态细节
- help / tips：承载指导与发现，而不是替代状态事实

这样可以避免三处信息互相重复。

### 3. tips/help 只保留当前 prototype 能力面内真实成立的提示

`Tips` 当前更像一个历史库存。这个 track 需要做的不是继续堆 tips，而是筛掉不可信或当前 prototype 未兑现的内容。

建议：

- 对 tips 做 capability audit
- 只保留当前 prototype 已经存在、用户可操作、能被验证的提示
- help/tips 的 wording 与 command palette / keybind / status surface 对齐

## 实施分解

### Phase 1: 冻结状态与指引职责边界

- 明确底栏、status dialog、help、tips 各自职责
- 明确哪些 tips 仍然可信可保留

### Phase 2: 打磨状态表达

- 打磨底栏 busy beacon 与状态文案
- 整理 `DialogStatus` 的信息层次

### Phase 3: 打磨指引表达

- 审核 help/tips 文案
- 保证指引与当前 prototype 能力一致

### Phase 4: 验证

- 用自动化测试固定关键文案与入口约束
- 用手工验收验证底栏、status、help、tips 的整体体验

## 测试策略

至少覆盖以下场景：

1. 底栏状态文案与 busy/idle 状态一致
2. `DialogStatus` 与 palette / shortcut 的入口仍正常
3. help / tips 不再引用已删除或不存在的旧 shell 入口
4. tips/help 中保留的关键快捷键和动作与当前实际能力一致

详细的自动化与手工功能验收步骤见 `acceptance.md`。

## 风险与取舍

### 风险 1: 过度打磨导致状态层重复表达

应对方式：

- 先明确三层职责，再改内容
- 底栏、status dialog、help/tips 各司其职

### 风险 2: tips/help 继续保留大量过时信息

应对方式：

- 用 capability audit 逐条审视
- 保留少而准的提示，优先当前 prototype 能验证的内容

## 交付结果

本 track 完成后，prototype TUI 应具备：

- 更一致的底栏状态语言
- 更可信的 status dialog / help / tips
- 与当前真实能力面对齐的状态与指引 surface
