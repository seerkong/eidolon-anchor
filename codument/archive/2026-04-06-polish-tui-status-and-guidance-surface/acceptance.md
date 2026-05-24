# Acceptance: polish-tui-status-and-guidance-surface

## 目标

确认 prototype TUI 的底栏状态、busy beacon、status dialog、help/tips 已形成一致且可信的状态与指引 surface。

## 验收范围

### In Scope

- 底栏状态文案
- 双侧 busy beacon
- bottom bar `History` / `Composer` 焦点切换入口的状态化打磨
- `DialogStatus`
- `DialogHelp`
- `Tips`

### Out Of Scope

- provider/model/session/MCP 等核心功能实现本身
- command palette 主功能
- 主题扩展

## 进入验收前提

- `codument validate polish-tui-status-and-guidance-surface --strict` 通过
- command palette 与主要 system surfaces 已可用
- terminal TUI 测试可运行

## 自动化验收

### A1. Track 结构验收

执行：

```bash
codument validate polish-tui-status-and-guidance-surface --strict
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
- 至少覆盖以下断言：
  - 状态/帮助入口仍能正常打开
  - help/tips 中保留的关键提示与当前 prototype 能力一致
  - 不再包含已删除旧 shell 的误导性入口
  - 底栏 polish 后，不破坏既有 history/composer 焦点切换与历史滚动恢复

## 手工功能验收

### M0. 启动方式

执行：

```bash
bun run dev:terminal:tui
```

### M1. 底栏状态点验

操作：

1. 分别观察 idle 和 busy 场景下的 composer 标题区与底栏
2. 如可模拟 retry / error，也一并观察
3. 点击 bottom bar 中的 `History` / `Composer`
4. 在 `History` 激活后验证历史区仍可滚动

通过标准：

- 双侧状态信标与实际状态一致
- composer 左上角显示当前 `agent · provider/model`
- 底栏中部展示 token usage、turn count、当前 turn 已运行时间
- selection / message count 与忙碌状态表达不互相冲突
- `History` / `Composer` 仍是正式可用的焦点切换入口
- 底栏 polish 不会破坏历史区滚动与 composer 输入语义

### M2. Status dialog 点验

操作：

1. 通过 command palette 或快捷键打开 status surface

通过标准：

- status dialog 可正常打开
- 系统状态信息层次清晰
- 与底栏摘要形成互补，而不是重复噪音

### M3. Help / Tips 点验

操作：

1. 打开 help dialog
2. 观察 tips（若已接入）

通过标准：

- 帮助与提示内容和当前 prototype 能力一致
- 不再引用已删除旧 shell 的入口
- 关键快捷键、palette、system surface 提示与当前实现一致

### M4. 负面验收

以下任一情况都判定为不通过：

- 底栏状态文案明显与真实状态不符
- busy beacon 与实际状态表达冲突
- help/tips 继续暴露已删除或不可用功能
- status dialog 与底栏、help/tips 三者信息严重重复或彼此矛盾
- 底栏 polish 后，`History` / `Composer` 按钮被移除、弱化到不可用，或切换后真实交互目标不一致

## 验收记录要求

- 自动化测试命令与结果
- 手工点验过的状态场景
- 保留/删除了哪些 tips 或帮助文案类别

## 本次实现记录

### 自动化记录

- `bun run --cwd terminal/packages/tui test tests/help-copy.test.ts tests/prototype-command-palette.test.tsx tests/prototype-scroll.test.tsx`
  - 结果：通过
  - 覆盖点：status/help 入口、帮助与 tips 文案对齐、旧 shell 文案清理、bottom bar `History` / `Composer` 焦点切换不破坏历史滚动恢复
- `bun run test:terminal:tui`
  - 结果：通过
  - 备注：`terminal/packages/tui/scripts/test.ts` 改为按测试文件逐个启动 `bun test`，规避了 Bun 1.3.6 在聚合进程退出阶段触发的 segmentation fault

### 手工点验记录

- 本轮未记录交互式手工点验
- 后续需要按 `M1` 到 `M3` 补齐 idle/busy 底栏、status dialog、help/tips 与 `History` / `Composer` 焦点切换后的历史滚动点验；这是当前唯一剩余阻塞项

### 文案收敛记录

- 保留：`/status`、`/session`、`/models`、`/theme`、`/agents`、`/connect`、`/actor`、`/member`、`/collective`、`/formation`、`History` / `Composer`、`alt+enter`、`PageUp/PageDown/Home/End`
- 删除：`/share`、`/undo`、`/redo`、`Build and Plan agents` 等当前 prototype 无法兑现或已不再正式暴露的旧提示

## 最终通过条件

只有在以下条件同时满足时，本 track 才算功能验收通过：

1. `spec.md` 中全部场景被验证
2. 底栏状态表达与实际状态一致
3. status/help/tips 与当前 prototype 能力面对齐
4. 不再暴露明显过时或误导性文案
5. gap-loop 不再发现阻塞性缺口
