# Acceptance: enhance-tui-approval-and-delegation-history

## 目标

确认新的 prototype TUI 同时具备：

- 可直接处理 permission / questionnaire 的 approval pane
- 可回看的 approval / questionnaire 历史摘要
- 可读的 delegation / question / task tree 结构化卡片

## 验收范围

### In Scope

- permission 的 allow once / allow always / reject 交互
- questionnaire 的单选、多选、多题切换、自定义答案、提交、reject
- approval / questionnaire 完成后的历史摘要
- `task`
- `question`
- `tasktreewrite`
- `tasktreeread`
- composer blocked / unblocked 与 approval 状态一致

### Out Of Scope

- provider/model/session/agent/MCP system surfaces
- command palette 主功能
- status / help / tips 文案 polish
- 重新设计 approval 或 question 卡片的视觉风格

## 进入验收前提

- `codument validate enhance-tui-approval-and-delegation-history --strict` 通过
- `add-tui-input-and-material-state-foundations` 已具备基础实现
- terminal TUI 测试可运行

## 自动化验收

### A1. Track 结构验收

执行：

```bash
codument validate enhance-tui-approval-and-delegation-history --strict
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
  - permission 支持 once / always / reject，且能展示 richer details
  - questionnaire 支持多题、多选、自定义答案、reject
  - 未答题组保持空数组，不自动填默认选项
  - active approval item 处理完成后进入历史区，而不是直接消失
  - `task`、`question`、`tasktreewrite`、`tasktreeread` 命中 dedicated cards
  - composer blocked / unblocked 与 active approval 状态一致

## 手工功能验收

### M0. 启动方式

执行：

```bash
bun run dev:terminal:tui
```

使用一个可重放 session 或受控测试 runtime transcript，至少覆盖：

- 一次 permission request
- 一次 questionnaire request
- 一次 delegated task
- 一次 `tasktreewrite` 或 `tasktreeread`

### M1. Permission 交互验收

操作：

1. 在存在活动 permission request 的会话中观察 approval pane
2. 分别验证 allow once、allow always、reject 三类回复路径

通过标准：

- approval pane 能直接操作，不只是显示阻塞提示
- pane 中能看到足够的 permission 上下文，例如 command、filepath、pattern 或 tool scope
- 回复后当前 active permission 从 pane 中消失

### M2. Questionnaire 交互验收

操作：

1. 打开包含 questionnaire request 的会话
2. 依次验证单选、多选、多题切换和自定义答案
3. 再验证 reject 路径

通过标准：

- 可通过键盘完成选项选择
- 多题切换时已答结果不会丢失
- 自定义答案可输入并纳入最终结果
- reject 不会误提交默认答案
- 未作答的问题组不会自动补成首选项

### M3. Approval / Questionnaire History 验收

操作：

1. 完成一次 permission 或 questionnaire 回复
2. 回到消息历史区查看回显

通过标准：

- 已完成请求以结构化摘要形式进入历史区
- 历史区能看出决策结果或回答结果
- 不会与当前 active pane 重复显示同一请求

### M4. Delegation / Question / Task Tree Card 验收

逐项检查：

| 工具 | 预期结果 |
| --- | --- |
| `task` | 展示 delegated task 摘要与当前进展 |
| `question` | 展示问题及其结构化结果，而不是纯文本摘要 |
| `tasktreewrite` | 展示写入的任务树语义 |
| `tasktreeread` | 展示读取出的任务树语义 |

通过标准：

- 四类工具都不是 generic fallback 外观
- 用户无需从原始输出文本手动还原语义
- active questionnaire 不会和 question card 形成双重交互入口

### M5. 一致性验收

操作：

1. 在 pending approval/question 时尝试提交普通 prompt
2. 在处理完成后再次提交普通 prompt

通过标准：

- pending 时 composer 正确阻塞
- 处理完成后 composer 正确解除阻塞
- blocked / unblocked 切换与 history 回显时机一致

### M6. 负面验收

以下任一情况都判定为不通过：

- approval pane 只能显示状态，不能完成实际回复
- questionnaire 自动填默认选项或丢失用户答案
- 请求处理完成后既不在 pane 中，也没有历史回显
- `task`、`question`、`tasktreewrite`、`tasktreeread` 仍显示为 generic fallback 或纯文本摘要
- 当前活动 question 同时出现在 approval pane 和可交互 question card 中
- composer blocked 状态与 active approval 状态不一致

## 验收记录要求

- 自动化测试命令与结果
- 手工点验覆盖过哪些 permission / questionnaire 场景
- delegation / question / task tree 覆盖结果
- 已知例外或剩余风险

## 最终通过条件

只有在以下条件同时满足时，本 track 才算功能验收通过：

1. `spec.md` 中全部场景被验证
2. permission / questionnaire 可在 approval pane 中直接完成交互
3. completed approval / questionnaire 可在历史区回看
4. delegation / question / task tree 已作为结构化卡片进入消息主链
5. composer blocked 语义与 approval 生命周期一致
6. gap-loop 不再发现阻塞性缺口

## 验收记录

### 2026-04-07

- `codument validate enhance-tui-approval-and-delegation-history --strict`
  - 结果：通过
- `bun run --cwd terminal/packages/tui test tests/prototype-approval-history-interaction.test.tsx`
  - 结果：通过
  - 覆盖：permission allow once 历史回显、questionnaire 多题切换、自定义答案、reject、问卷中心计数、delegation/question/tasktree cards、composer blocked/unblocked 切换
- `bun run test:terminal:tui`
  - 结果：命令退出码为 `0`
  - 备注：测试输出中仍会打印一次 `tests/prototype-command-palette.test.tsx` 相关的 Yoga stack trace，但未导致 suite 失败；本 track 新增交互测试与原有 focused tests 均通过

### 当前结论

- approval pane 中的 permission 交互可直接完成回复，并在主消息历史中生成结构化 summary
- questionnaire 交互可在 approval pane 中完成多题与自定义答案流程，完成后由问卷中心承担历史回看与状态聚合
- `task`、`question`、`tasktreewrite`、`tasktreeread` 在主消息链中命中 dedicated cards
- composer blocked 状态会随 active permission/question 生命周期切换
- gap-loop 已按协议完成两轮 fresh review，`track-impl-gap-report-1.md` 与 `track-impl-gap-report-2.md` 均返回 `NO_GAP`
