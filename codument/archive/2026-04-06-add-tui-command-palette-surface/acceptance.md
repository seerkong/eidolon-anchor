# Acceptance: add-tui-command-palette-surface

## 目标

确认新的 prototype TUI 已拥有可用的 command palette surface，并能作为 session、provider/model、agent、MCP、status、help 等动作的统一入口。

## 验收范围

### In Scope

- command palette host 挂载
- `command_list` 快捷键打开 palette
- palette 列表筛选与选择
- session / provider-model / agent / MCP / status / help 的 action registration
- palette 触发与快捷键直达一致

### Out Of Scope

- 复杂推荐算法
- 重做 slash command 体系
- tips/status/help 文案 polish

## 进入验收前提

- `codument validate add-tui-command-palette-surface --strict` 通过
- 前置 system surfaces 已具备基础实现
- terminal TUI 测试可运行

## 自动化验收

### A1. Track 结构验收

执行：

```bash
codument validate add-tui-command-palette-surface --strict
```

通过标准：

- track 严格校验通过

### A2. TUI 自动化测试验收

执行：

```bash
bun run test:terminal:tui
```

通过标准：

- terminal TUI 测试通过
- 至少包含以下断言：
  - `command_list` 能打开 command palette
  - palette 中出现首批 action
  - 选择 palette action 与直接快捷键触发共用同一行为
  - 未就绪 action 不会导致 palette 打开时报错

## 手工功能验收

### M0. 启动方式

执行：

```bash
bun run dev:terminal:tui
```

使用支持 system surfaces 的 prototype session。

### M1. 打开与关闭验收

操作：

1. 使用配置中的 `command_list` 快捷键打开 palette
2. 默认配置下该快捷键应为 `Ctrl+P`
3. 使用 `Esc` 关闭 palette

通过标准：

- palette 成功打开
- 关闭后焦点回到原交互位置
- 不出现卡死或焦点丢失

### M2. 列表与筛选验收

操作：

1. 打开 palette
2. 输入 `session`、`model`、`agent`、`mcp`、`status`、`help` 等关键词

通过标准：

- 列表能按名称筛选
- 能看到首批 actions 的标题、分组和快捷键信息
- suggested actions 如已配置，会以独立分组出现

### M3. 动作触发验收

至少点验以下动作各一次：

| 动作类别 | 预期结果 |
| --- | --- |
| session | 打开会话列表或相关 session surface |
| provider/model | 打开 provider 或 model 管理 dialog |
| agent | 打开 agent 选择 dialog |
| MCP | 打开 MCP 管理 dialog |
| status | 打开 status surface |
| help | 打开 help dialog 或帮助界面 |

通过标准：

- 从 palette 选择动作后，打开的是正确的 surface
- 行为与原有 direct shortcut 一致
- 不会打开错误 dialog

### M4. 一致性验收

操作：

1. 对至少一个已有快捷键动作，分别用 direct shortcut 和 palette 各触发一次

通过标准：

- 两种路径产生相同结果
- 不存在 palette 走一套 handler、快捷键走另一套 handler 的分叉

### M5. 负面验收

以下任一情况都判定为不通过：

- `command_list` 无法打开 palette
- palette 打开后为空壳，没有首批 action
- palette 触发与 direct shortcut 行为不一致
- 某个未就绪 surface 导致 palette 直接报错
- 关闭 palette 后焦点无法恢复

## 验收记录要求

- 自动化测试命令与结果
- 手工点验过的 action 类别
- direct shortcut 与 palette 一致性检查结果

## 最终通过条件

只有在以下条件同时满足时，本 track 才算功能验收通过：

1. `spec.md` 中全部场景被验证
2. `command_list` 可稳定打开 command palette
3. palette 已接入首批 actions
4. palette 与 direct shortcut 行为一致
5. gap-loop 不再发现阻塞性缺口
