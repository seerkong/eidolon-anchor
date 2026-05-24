# Acceptance: add-tui-research-tool-cards

## 目标

确认 prototype TUI 已正式启用 `webfetch`、`codesearch`、`websearch` 三类 research tool cards，且不破坏 coding cards 与 generic fallback。

## 验收范围

### In Scope

- `webfetch`
- `codesearch`
- `websearch`
- coding cards 不回归
- unsupported tool fallback 不回归

### Out Of Scope

- `task`、`question`、`tasktreewrite`、`tasktreeread`
- provider/model、session switcher、agent/MCP、command palette
- 重新设计 research cards 的视觉样式

## 进入验收前提

- `codument validate add-tui-research-tool-cards --strict` 通过
- `add-tui-coding-tool-part-cards` 已完成
- terminal TUI 测试可运行

## 自动化验收

### A1. Track 结构验收

执行：

```bash
codument validate add-tui-research-tool-cards --strict
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
  - `resolvePrototypeToolCard("webfetch")` 命中 dedicated card
  - `resolvePrototypeToolCard("codesearch")` 命中 dedicated card
  - `resolvePrototypeToolCard("websearch")` 命中 dedicated card
  - `resolvePrototypeToolCard("edit")`、`resolvePrototypeToolCard("patch")` 等 coding cards 仍命中原卡片
  - unknown tool 仍命中 `GenericTool`

## 手工功能验收

### M0. 启动方式

执行：

```bash
bun run dev:terminal:tui
```

使用一个可重放 session 或测试 transcript，至少包含：

- 一次 `webfetch`
- 一次 `codesearch`
- 一次 `websearch`
- 一次 coding tool，例如 `edit` 或 `bash`
- 一次 unsupported tool

### M1. Research card 点验

逐项检查：

| 工具 | 预期界面特征 |
| --- | --- |
| `webfetch` | 展示抓取 URL，而不是 generic 文本 |
| `codesearch` | 展示 query 与结果数量语义 |
| `websearch` | 展示 query 与结果数量语义 |

通过标准：

- 三类 research tools 都不是 `GenericTool` 外观
- 三类 research tools 都不是旧摘要卡
- 卡片能读取到 runtime `input` / `metadata`

### M2. 不回归点验

操作：

1. 在同一会话或相邻会话中观察至少一个 coding tool
2. 观察一个 unsupported tool

通过标准：

- coding tool 仍显示为原 dedicated card
- unsupported tool 仍显示为 generic fallback
- 不存在 research card 接入后导致 coding/fallback 路由错乱

### M3. 负面验收

以下任一情况都判定为不通过：

- `webfetch`、`codesearch` 或 `websearch` 仍显示为 `GenericTool`
- research tools 消失不显示
- coding cards 被 research 改造连带破坏
- unsupported tool 被错误映射到 research card

## 验收记录要求

- 自动化测试命令与结果
- 手工点验覆盖了哪三类 research tools
- coding card 与 fallback 回归检查结果

## 最终通过条件

只有在以下条件同时满足时，本 track 才算功能验收通过：

1. `spec.md` 中全部场景被验证
2. `webfetch`、`codesearch`、`websearch` 三类工具均命中 dedicated card
3. coding cards 与 generic fallback 无回归
4. gap-loop 不再发现阻塞性缺口
