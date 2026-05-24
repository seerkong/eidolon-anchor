# Design: add-tui-command-palette-surface

## 目标

让新的 prototype-first TUI 拥有一个真正可用的 command palette surface，作为 system materials 和常用动作的统一发现与触发入口。

## 当前现状

### 1. command palette 底件已经存在，但没有接入 prototype shell

- `terminal/packages/tui/src/cli/cmd/tui/component/dialog-command.tsx`
  - 已有 `CommandProvider`
  - 已有 `register()`、`show()`、`trigger()` 能力
  - 已支持 `command_list` 快捷键直接打开 dialog
- `terminal/packages/tui/src/runtime/TuiRuntimeCatalog.ts`
  - 已配置 `command_list: "ctrl+p"` 默认快捷键

但：

- `terminal/packages/tui/src/cli/cmd/tui/prototype/index.tsx`
  - 当前 `prototypeTui()` 直接渲染 `PrototypeView`
  - 没有挂载 `CommandProvider`
  - 也没有显式挂载 `DialogProvider` 这种 palette host 依赖

结论：palette 底件存在，但 prototype 入口并没有真正启用它。

### 2. command catalog 已存在，但没有统一的 prototype action registration

- `terminal/packages/tui/src/cli/cmd/tui/command/catalog.ts`
  - 已定义 `COMMAND_ID`
  - 已定义 `SLASH_COMMANDS`
- 已有 system materials：
  - session list
  - provider/model
  - agent
  - MCP
  - status

但当前没有一层清晰的 registration，把这些能力收束成 palette 可见的 actions。

结论：命令 ID 存在，surface 素材存在，但“把谁注册进 palette、怎么触发”还没有收束。

### 3. palette 需要保证“统一入口”，而不是“第二套命令系统”

如果 palette 只是复制一份 onSelect 逻辑，就会出现：

- palette 触发一套 handler
- 直接快捷键触发另一套 handler
- slash command 再走第三套路径

这会让行为漂移和维护成本迅速上升。

结论：本 track 的关键是收口 action registration，而不是只把 dialog 弹出来。

## 约束

- 本 track 默认建立在主要 system surface tracks 已具备基础素材的前提上
- palette 应作为统一入口层，而不是替代直接快捷键
- 不应为 palette 新建平行状态真相
- palette 必须复用现有 dialog / surface / route / runtime 能力，而不是复制一份逻辑

## 目标方案

### 1. 在 prototype shell 中引入 palette host/provider 链

本 track 首先要解决“palette 根本没有挂载”的问题。

建议在 prototype 根部引入 palette 所需 provider 链，例如：

- `DialogProvider`
- `CommandProvider`
- palette 需要的其他上下文 provider

关键要求：

- prototype 任何位置都可以触发 palette
- `command_list` 快捷键能从全局打开 palette
- 打开 palette 不会破坏当前 composer / message view 的焦点恢复

当前冻结的 provider 边界为：

- `ArgsProvider`
- `ExitProvider`
- `KVProvider`
- `ToastProvider`
- `SyncProvider`
- `ThemeProvider`
- `KeybindProvider`
- `DialogProvider`
- `RouteProvider`
- `LocalProvider`
- `CommandProvider`

### 2. 为 prototype 建立显式 action registration 层

不要在 palette 组件内部临时拼命令列表，建议单独建立 registration 层，负责：

- command id
- title / category / description
- keybind 显示
- onSelect / onTrigger
- suggested 标记

首批建议覆盖：

- session list
- provider connect
- provider/model
- agent
- MCP
- status
- help
- theme

如果某个前置 surface 尚未可用，应允许：

- 不注册该 action
- 或以 disabled / hidden 方式处理

而不是让 palette 打开报错。

### 3. 统一快捷键直达与 palette 触发

对于已有快捷键的动作，应该共用同一层动作定义。

目标行为：

- 直接按快捷键 -> 调用对应 action
- 打开 palette 选择同一动作 -> 调用同一 action

这样 command palette 只是入口不同，不是逻辑不同。

### 4. suggested actions 应服务当前 prototype 场景

`dialog-command.tsx` 已支持 `suggested` 分组。这个能力适合拿来做：

- 常用 system surfaces
- 当前会话上下文下更合适的动作

但本 track 不要求做复杂推荐算法。第一阶段只需要：

- 有一组固定的 suggested actions
- 它们与主列表复用同一 action handler

## 实施分解

### Phase 1: 冻结 palette host 和 action registration 边界

- 明确 prototype 根部要挂哪些 provider
- 明确哪些 actions 必须进入 palette 首批范围
- 明确 unavailable surfaces 的处理策略

### Phase 2: 接入 command palette host

- 把 `CommandProvider` 挂入 prototype shell
- 让 `command_list` 快捷键能够打开 palette
- 保证 dialog 焦点和关闭行为正常

### Phase 3: 注册首批 actions

- 把 session / provider-model / agent / MCP / status / help 接入 palette
- 让 palette 显示标题、分组、快捷键信息
- 让 palette 选择与 direct keybind 走同一 handler

### Phase 4: 验证

- 自动化验证 command catalog 和 registration 行为
- 手工验证 palette 打开、筛选、选择、关闭和快捷键一致性

## 测试策略

至少覆盖以下场景：

1. prototype 已挂载 palette host，`command_list` 可打开 palette
2. palette 中出现首批 system actions
3. 选择 palette action 与直接快捷键触发同一行为
4. 某些未就绪 surfaces 不会导致 palette 打开时报错

详细的自动化与手工功能验收步骤见 `acceptance.md`。

## 风险与取舍

### 风险 1: palette 只是弹窗壳，内部 action 仍分散

应对方式：

- 在计划中明确建立 registration 层
- 测试中覆盖“palette 触发与快捷键直达一致”

### 风险 2: provider / dialog 链接入时破坏当前 prototype 焦点行为

应对方式：

- 复用现有 `DialogProvider` 的焦点恢复机制
- 手工验收时专门检查打开、关闭、返回输入框的行为

## 交付结果

本 track 完成后，新的 prototype TUI 应具备以下能力：

- 用户可以通过 `command_list` 快捷键或统一入口打开 palette
- palette 中可以触发首批 system/material actions
- palette 与直接快捷键触发共用同一套动作定义，不出现行为分叉
