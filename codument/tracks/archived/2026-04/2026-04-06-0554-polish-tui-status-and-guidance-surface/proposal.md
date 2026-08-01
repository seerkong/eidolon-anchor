# 变更：打磨 TUI 状态与指引界面

## 背景和动机

prototype TUI 里与“状态/指引”有关的素材已经分散存在：

- 底栏有双侧扫描信标和基础 selection / message count 文案
- `BusyBeacon` 组件已经存在，但当前底栏并未复用它
- `DialogStatus` 已可通过 command palette 打开
- `DialogHelp` 已存在
- `Tips` 组件和大量提示文案已经沉淀，但目前没有真正接入 prototype 主链

这说明当前不是“完全没有状态与指引界面”，而是它们还没有被收敛成一个统一、可信、与真实能力同步的 surface。继续放任分散状态，会带来两个问题：

- 用户看到的状态语言不够一致，例如底栏仍有硬编码文案
- tips/help 容易继续携带与当前 prototype 不一致的旧能力提示

这个 track 的目标是把这些已存在素材打磨成收尾层，而不是重新设计系统功能。

## “要做”和“不做”

**目标:**

- 统一底栏、status dialog、help/tips 的状态与指引语言
- 将双侧 busy beacon 与实际会话状态表达对齐
- 保留并打磨底栏中已正式化的 `History` / `Composer` 焦点切换入口
- 将当前 `agent · provider/model` 选择摘要移入 composer 标题区，而不是继续占用底栏中部
- 让底栏中部收敛为 token usage、turn count、当前 turn 运行时间等轻量指标
- 让 tips/help 只暴露当前 prototype 真实存在的能力
- 形成更稳定的状态与指引 surface

**非目标:**

- 本 track 不负责新增 provider/model/session/MCP 等核心功能
- 本 track 不重做 message area、composer、command palette 主功能
- 本 track 不移除、弱化或改写已验证通过的历史区/ composer 焦点切换与滚动恢复语义
- 本 track 不把 tips 变成复杂 onboarding 系统
- 本 track 不承担 theme 扩展工作

## 变更内容

- 打磨底栏 busy beacon 与状态文案
- 在不破坏底栏焦点切换语义的前提下，整理底栏布局和文案层级
- 将 selection summary 从底栏迁移到 composer 标题区，并为底栏补充会话指标
- 在 runtime 有精确 tokens 时展示正式 usage，在 prototype local mode 中则显示带标记的估算值
- 审视并调整 `DialogStatus` 的信息层级和表达
- 调整 help / tips，使其与当前 prototype 能力面一致
- 将分散状态素材收敛为统一状态与指引语言

## 影响范围

- 受影响的规范：`terminal-tui-shell`
- 受影响的代码：
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/bottom-bar.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/index.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/composer.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/component/prompt/busy-beacon.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/system/status/status-dialog.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/ui/dialog-help.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/component/tips.tsx`
  - `terminal/packages/tui/tests/prototype-scroll.test.tsx`
  - `terminal/packages/tui/tests/help-copy.test.ts`

## 顺序依赖关系

- 建议序号：`13`
- 建议前置：
  - `enhance-tui-approval-and-delegation-history`
  - `add-tui-system-management-surfaces`
  - `add-tui-command-palette-surface`
- 建议后续：无，属于当前这批 tracks 的收尾 polish 项
- 说明：状态与指引界面应建立在主要功能 surface 已经落地之后，否则容易反复返工文案和状态语言
