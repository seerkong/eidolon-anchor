## ADDED Requirements

### Requirement: Status And Guidance Surface

系统应当（SHALL）继续打磨 prototype TUI 的状态与指引界面，包括状态展示、忙碌信标和使用提示。

#### Scenario: Provide clear status and system guidance

- **GIVEN** 用户需要了解当前系统状态或下一步可做的操作
- **WHEN** TUI 渲染状态与指引区域
- **THEN** 系统提供清晰的状态信息和使用提示
- **AND** 这些信息不应干扰主消息区与输入区
- **AND** 不破坏底栏 `History` / `Composer` 焦点切换与历史滚动恢复

#### Scenario: Guidance remains aligned with the actual feature surface

- **GIVEN** TUI 的能力边界发生变化
- **WHEN** 指引界面展示帮助和 tips
- **THEN** 系统展示与当前真实能力一致的提示
- **AND** 不继续暴露已经删除或不存在的旧 shell 入口

#### Scenario: Busy beacons and status copy reflect actual runtime state

- **GIVEN** 当前会话处于 busy、idle、retry、error 或其他可感知状态
- **WHEN** 用户观察底栏或相关状态界面
- **THEN** 系统以一致的视觉语言表达这些状态
- **AND** 不继续使用与实际状态脱节的硬编码描述

#### Scenario: Bottom bar polish preserves real focus-switch behavior

- **GIVEN** 底栏同时承担状态摘要和 `History` / `Composer` 焦点切换入口
- **WHEN** 后续对底栏布局、文案或 busy beacon 做 polish
- **THEN** 系统仍保留显式焦点切换控件
- **AND** 不出现“视觉状态更新了，但真实输入/滚动目标被破坏”的回归

#### Scenario: Selection summary moves into the composer chrome while the bottom bar shows compact metrics

- **GIVEN** 当前会话已有 agent/provider/model 选择信息，且用户需要持续看到基础会话指标
- **WHEN** TUI 渲染 composer 标题区和底栏
- **THEN** 系统在 composer 左上角显示当前 `agent · provider/model`
- **AND** 底栏中部改为显示 token usage、turn count 和当前 turn 运行时间等紧凑指标
- **AND** 当 prototype local mode 暂无精确 token usage 时，系统明确使用可识别的估算值而不是伪装成精确统计
- **AND** 底栏不再用中部文案重复表达焦点激活状态
- **AND** 不破坏右侧 `History` / `Composer` 按钮的真实焦点切换语义

#### Scenario: Tips remain optional guidance rather than noisy chrome

- **GIVEN** prototype 已接入更多功能与快捷入口
- **WHEN** 系统展示 tips 或帮助信息
- **THEN** 提示内容应帮助用户理解真实可用能力
- **AND** 不喧宾夺主或干扰消息区与输入区的主流程
