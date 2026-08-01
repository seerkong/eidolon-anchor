# Acceptance: add-tui-coding-tool-part-cards

## 目标

确认新的 prototype TUI 已经把首批 coding 工具调用从“摘要型 tool 卡片”升级为“基于 runtime `ToolPart` 的结构化专用卡片”，并且未覆盖工具仍然有 generic fallback。

## 验收范围

### In Scope

- `bash`
- `edit`
- `write`
- `read`
- `grep`
- `glob`
- `list`
- `patch`
- unsupported tool fallback
- 同一 `ToolPart` 的 pending / completed / error 状态更新
- assistant 文本与 tool part 的顺序保持

### Out Of Scope

- `task`、`question`、`tasktreewrite`、`tasktreeread`
- `webfetch`、`codesearch`、`websearch`
- theme、session list、provider/model、agent/MCP 等 system surfaces

## 进入验收前提

- `codument validate add-tui-coding-tool-part-cards --strict` 通过
- 相关实现已完成 `plan.xml` 中 P2、P3、P4 的任务
- terminal TUI 测试可运行

## 自动化验收

### A1. Track 结构验收

执行：

```bash
codument validate add-tui-coding-tool-part-cards --strict
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
- 新增测试至少覆盖以下内容：
  - assistant 文本与多个 tool parts 的 timeline 顺序
  - 首批 coding 工具命中 dedicated card
  - unsupported tool 命中 `GenericTool`
  - 同一 `ToolPart` 多次更新时 identity 不漂移

### A3. 建议新增的测试矩阵

实现本 track 时，自动化测试至少应补齐下列断言：

| 编号 | 测试目标 | 最低断言 |
| --- | --- | --- |
| AT-1 | tool part 投影 | assistant message 同时含 text + tool parts 时，输出顺序与原始 parts 一致 |
| AT-2 | dedicated card 路由 | `bash`、`edit`、`write`、`read`、`grep`、`glob`、`list`、`patch` 命中 registry 中的专用卡片 |
| AT-3 | fallback 路由 | allowlist 外工具命中 `GenericTool` |
| AT-4 | live update | 同一 `part.id` 从 pending 变 completed / error 时，仍对应同一条渲染 item |
| AT-5 | 无回退为摘要卡 | 首批工具不会再被投影为仅含 `tool + summary` 的旧摘要消息 |

## 手工功能验收

### M0. 启动方式

执行：

```bash
bun run dev:terminal:tui
```

使用一个可重放的开发 session 或测试 runtime transcript。该 transcript 必须包含：

- assistant 文本
- 至少一次 `bash`
- 至少一次 `edit`
- 至少一次 `write`
- 至少一次 `read`
- 至少一次 `grep`
- 至少一次 `glob`
- 至少一次 `list`
- 至少一次 `patch`
- 至少一个 unsupported tool
- 至少一个 tool part 的 pending -> completed 更新
- 至少一个 tool part 的 pending -> error 更新

如果没有现成 transcript，可用受控测试会话人工触发这些工具，但最终仍要覆盖上面的完整矩阵。

### M1. 消息顺序验收

操作：

1. 打开包含 assistant 文本和多个 tool parts 的会话
2. 观察消息区中 assistant 文本与 tool cards 的前后顺序

通过标准：

- assistant 文本与 tool cards 的显示顺序和 runtime parts 顺序一致
- tool card 不会被错误并入 assistant 文本块

### M2. 首批工具专用卡片验收

对每种工具至少点验一次：

| 工具 | 预期界面特征 |
| --- | --- |
| `bash` | 展示命令文本；如有输出，展示块级输出；长输出可折叠/展开 |
| `edit` | 展示文件路径和 diff，而不是摘要说明 |
| `write` | 展示写入目标和内容块；有 diagnostics 时可见错误信息 |
| `read` | 展示读取文件语义，而不是 generic 文本 |
| `grep` | 展示 pattern 和目标路径/匹配计数语义 |
| `glob` | 展示 pattern 和目标路径/匹配计数语义 |
| `list` | 展示目录列举语义 |
| `patch` | 展示 patch 结果块或 patch 执行语义 |

通过标准：

- 首批工具都不是 generic fallback 外观
- 首批工具都不是旧的摘要 `tool + summary` 卡片
- 卡片内容能读取 runtime `input` / `output` / `metadata`

### M3. Fallback 验收

操作：

1. 在同一会话中观察一个不在首批 allowlist 内的工具 part

通过标准：

- 该工具仍然显示在消息区
- 该工具走 generic fallback，而不是消失
- 不会错误命中某个不相干的专用卡片

### M4. Live Update 验收

操作：

1. 观察一个先进入 pending 的工具调用
2. 等待其更新为 completed 或 error

通过标准：

- 更新前后是同一张卡片位置，而不是删除后新插一张
- completed 时能看到最终输出或完成态
- error 时能看到错误态或错误信息

### M5. 负面验收

以下任一情况都判定为不通过：

- 首批工具仍显示旧摘要卡
- unsupported tool 在消息区消失
- 同一 tool call 更新时出现重复卡片或跳位
- assistant 文本与 tool cards 顺序错乱
- 某张专用卡片因为缺少上下文依赖而直接报错

## 验收记录要求

至少保留以下记录：

- 自动化测试命令与结果
- 手工验收覆盖了哪些工具
- 未完成覆盖的工具或已知例外
- 如果走 gap-loop，记录最终发现与修复结论

## 最终通过条件

只有在以下条件同时满足时，本 track 才算功能验收通过：

1. `spec.md` 中三个场景全部被验证
2. 自动化测试通过
3. 手工验收覆盖首批 8 个 coding 工具和 1 个 unsupported tool
4. live update 与 fallback 行为均通过
5. gap-loop 不再发现阻塞性缺口
