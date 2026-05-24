# Design: enhance-tui-scroll-and-selection-mechanics

## 目标

在现有 prototype TUI 的 scroll 主链上，补齐“历史浏览、流式更新、文本选择、边界跳转”之间的可靠协调。

## 当前现状

### 1. 基础滚动主链已经存在

- `terminal/packages/tui/src/cli/cmd/tui/prototype/infra/perf/scroll-history.ts`
  - 已有 `scrollToBottom`
  - 已有 `scrollByViewport`
  - 已有 `scrollByLine`
  - 已有 `scrollToEdge`
  - 已有 `handleHistoryWheelScroll`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/index.tsx`
  - 已接入滚轮、方向键、PageUp/PageDown、Home/End
  - scrollbox 已启用 `stickyScroll`

结论：这个 track 不需要从零开始写滚动系统。

### 2. 现有实现仍偏基础，协调规则不够明确

当前存在几个明显风险：

- `scrollToBottom(...)` 会在流式输出、runtime message 更新、runtime part 更新等场景反复调用
- `handleHistoryWheelScroll(...)` 本身只是直接滚动并阻止默认事件，没有显式考虑文本选择或手动浏览意图
- 目前没有一套被测试固定下来的“何时自动跟随底部、何时尊重用户手动浏览”的规则

结论：真正的 gap 在交互规则与稳定性，而不是在 helper 数量。

### 3. 现有测试覆盖面有限

- `terminal/packages/tui/tests/prototype-scroll.test.tsx`
  - 已覆盖鼠标滚轮滚动
  - 已覆盖空 composer 下方向键滚动
- `terminal/packages/tui/tests/help-copy.test.ts`
  - 已检查 alternate screen / mouse tracking 相关基础约束

但尚未覆盖：

- PageUp / PageDown
- Home / End
- 文本选择与滚动协调
- 手动浏览期间遇到流式更新
- 是否会被强制跳回底部

## 约束

- 本 track 必须复用已有 `scroll-history.ts` 和 `PrototypeView` 主链
- 不引入新的平行 scroll state 真相
- 不破坏当前 message area / composer 的基础交互
- 尽量用测试固定规则，而不是靠“感觉上更顺”

## 目标方案

### 1. 明确“自动跟底”与“手动浏览”切换规则

需要先冻结规则，否则后续只会反复调参。

建议至少定义：

- 用户处于底部附近时：允许自动跟底
- 用户主动向上浏览历史时：暂停自动跟底
- 用户明确跳回底部时：恢复自动跟底

关键不是某个具体像素阈值，而是先把行为语义写清楚并测试固定。

### 2. 选择态优先于激进滚动副作用

文本选择期间，如果自动滚动或某些鼠标行为持续打断选择，会直接破坏可用性。

建议规则：

- 有活跃文本选择时，不应因为轻微更新就强制改动视口
- 与选择冲突的点击/滚动副作用要有显式守卫

这与现有 `tool-chrome.tsx` 中“若已有 selection 则不触发 click action”的思路一致。

### 3. 用测试把关键导航路径固定下来

本 track 最重要的产出之一是把高风险滚动路径写成自动化断言：

- wheel
- arrow
- PageUp / PageDown
- Home / End
- 手动浏览 + 流式更新

这样之后消息区和卡片继续演进时，不会无意把滚动体验打坏。

## 实施分解

### Phase 1: 冻结滚动与选择规则

- 明确自动跟底规则
- 明确选择态协调规则
- 明确边界跳转预期

### Phase 2: 调整 scroll helpers 和视图接线

- 在现有 helper 上增强逻辑
- 在 `PrototypeView` 中处理好自动跟底与手动浏览切换
- 避免不必要的强制滚动

### Phase 3: 验证

- 补齐滚动相关自动化测试
- 手工点验不同输入路径和终端模式下的表现

## 测试策略

至少覆盖以下场景：

1. 鼠标滚轮滚动仍正常
2. composer 为空时方向键滚动仍正常
3. PageUp / PageDown / Home / End 行为稳定
4. 用户手动浏览历史时，流式更新不会强制跳底
5. 文本选择存在时，滚动或点击副作用不会明显破坏选择体验

详细的自动化与手工功能验收步骤见 `acceptance.md`。

## 风险与取舍

### 风险 1: 规则不清，自动滚底与手动浏览反复打架

应对方式：

- 先写规则，再改实现
- 把“何时跟底、何时暂停”写成测试

### 风险 2: 过度修正导致当前基础滚动回归

应对方式：

- 保留现有 smoke tests
- 新测试与旧测试并存，不覆盖掉基础路径

## 交付结果

本 track 完成后，prototype TUI 应具备：

- 更稳定的历史浏览体验
- 更可预测的边界跳转
- 在文本选择和流式更新存在时仍能保持合理滚动行为
