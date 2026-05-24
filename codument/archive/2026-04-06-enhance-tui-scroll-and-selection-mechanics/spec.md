## ADDED Requirements

### Requirement: Scroll And Selection Mechanics

系统应当（SHALL）继续增强 prototype TUI 的滚动与选择机制，保证历史浏览、定位和滚动副作用稳定。

#### Scenario: Maintain reliable history scrolling

- **GIVEN** 消息区包含较长历史
- **WHEN** 用户使用滚轮、触摸板、行滚动、页滚动或跳转边界
- **THEN** 系统保持稳定的 scroll 行为
- **AND** 不因消息流式更新而错误跳动

#### Scenario: Selection and scroll behavior stay coordinated

- **GIVEN** 用户在消息区存在文本选择或正在进行交互
- **WHEN** 滚动逻辑触发
- **THEN** 系统避免与选择状态产生冲突
- **AND** 保持符合终端交互预期的行为

#### Scenario: Manual history browsing is not overridden by streaming updates

- **GIVEN** 用户已主动滚离消息底部浏览历史
- **WHEN** assistant 继续流式输出或 runtime 继续更新消息
- **THEN** 系统不会错误强制跳回底部
- **AND** 只有在符合既定规则时才恢复自动跟随

#### Scenario: Edge and viewport navigation remain predictable

- **GIVEN** 用户使用 `PageUp`、`PageDown`、`Home`、`End` 或等价快捷键
- **WHEN** TUI 执行历史定位
- **THEN** 系统表现出一致、可预测的边界跳转行为
- **AND** 不出现跨终端下明显失控的滚动偏移

#### Scenario: History focus can be recovered while the composer still contains draft text

- **GIVEN** 输入框中仍保留未提交内容
- **WHEN** 用户点击历史区并尝试滚动历史
- **THEN** 系统允许历史区重新获得活跃焦点
- **AND** 用户无需清空输入内容也能继续浏览上方历史

#### Scenario: Composer and history regions expose visible focus feedback

- **GIVEN** 用户在输入区与历史区之间切换交互目标
- **WHEN** 焦点区域发生变化
- **THEN** 系统通过颜色变化明确显示当前活跃区域
- **AND** 不依赖额外文案才能区分当前焦点

#### Scenario: Bottom bar focus controls stay aligned with region focus semantics

- **GIVEN** 用户需要明确地在历史区和 composer 之间切换交互目标
- **WHEN** 用户点击底栏中的 `History` 或 `Composer`
- **THEN** 系统将对应区域设为活跃焦点目标
- **AND** 底栏控件、区域下方提示线与真实滚动/输入行为保持一致
