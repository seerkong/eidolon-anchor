# 变更：增强 TUI 滚动与选择机制

## 背景和动机

prototype TUI 已经具备基础滚动能力：

- `scroll-history.ts` 已提供 wheel / line / viewport / edge helpers
- `PrototypeView` 已接入滚轮、方向键、PageUp/PageDown、Home/End 等基础滚动入口
- `prototype-scroll.test.tsx` 已覆盖鼠标滚轮与空输入框下的方向键 smoke tests

但当前实现仍偏基础：

- 流式更新时会频繁调用 `scrollToBottom(...)`
- `handleHistoryWheelScroll(...)` 本身没有显式考虑选择态或用户手动浏览意图
- 现有测试尚未覆盖 PageUp/PageDown/Home/End、手动浏览与流式更新并存、文本选择与滚动冲突等关键场景

这个 track 的目标不是重新发明滚动系统，而是在现有 prototype scroll 主链上补齐可靠性、选择态协调和终端交互稳定性。

## “要做”和“不做”

**目标:**

- 增强消息区历史滚动、边界跳转和手动浏览稳定性
- 让触摸板、滚轮与键盘在历史区聚焦语义下保持一致
- 明确文本选择、流式更新和自动滚底之间的协调规则
- 将底栏 `History` / `Composer` 交互正式化为显式焦点切换控件
- 补齐滚动相关自动化测试与手工验收
- 继续稳定不同终端下的滚动体验

**非目标:**

- 本 track 不重做消息区布局或卡片结构
- 本 track 不重做 command palette、status surface 或 composer 功能
- 本 track 允许在现有 bottom bar 中增加最小焦点切换控件，但不扩展成新的状态面板功能
- 本 track 不引入新的平行 scroll state 系统
- 本 track 不把滚动优化扩展成大规模视觉动效改造

## 变更内容

- 打磨 `scroll-history.ts` 与 `PrototypeView` 中的滚动逻辑
- 明确自动滚底、手动滚动、文本选择之间的优先级
- 将历史区焦点恢复与 bottom bar 焦点切换整理为共享交互契约
- 修复 composer 保留草稿时，历史区在真实终端里的滚轮 / 触摸板 / 键盘滚动恢复
- 为 PageUp/PageDown/Home/End 和选择态场景补测试
- 继续保证 alternate scroll / mouse scroll 行为在终端里稳定

## 影响范围

- 受影响的规范：`terminal-tui-shell`
- 受影响的代码：
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/infra/perf/scroll-history.ts`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/index.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/composer.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/bottom-bar.tsx`
  - `terminal/packages/tui/tests/prototype-scroll.test.tsx`
  - `terminal/packages/tui/tests/help-copy.test.ts`
  - 可能涉及 selection / renderer 相关交互守卫

## 顺序依赖关系

- 建议序号：`12`
- 建议前置：
  - `add-tui-coding-tool-part-cards`
  - `add-tui-structured-composer-interactions`
- 建议后续：
  - `polish-tui-status-and-guidance-surface`
- 说明：它更像跨切面的稳定性打磨项，最好在消息区和输入区主能力接上后再集中处理
