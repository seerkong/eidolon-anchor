# Flow Notation 规范

复杂 action / skill / actor drive 的流程不要只靠散文描述。凡是涉及事件路由、阶段切换、循环、分支、等待回执、失败退出的内容，用 Markdown 说明背景，用 `text` 围栏内的流程标记块表达可执行控制流。

## 开头约定

每个流程标记块开头建议先写三行自解释声明，让新读者不需要猜符号含义：

```text
@delimiter: --      # 块深度分隔符；根层 --，每深入一层多一个 --
@node: #            # 流程节点前缀；对应 XML/AST 中的节点名，如 #switch / #case / #step / #loop / #return
@marker: ?          # 块标识 / 跳转锚点前缀；如 ?event / ?confirm / ?done
```

含义：

- `@delimiter: --` 定义层级单位。`--` 是根块，`----` 是子块，`------` 是孙块。
- `#` 后面是流程节点名，说明这一块怎样执行：分支、步骤、循环、返回、退出等。
- `?` 后面是块标识，用于开闭块配对，也可作为 `#goto target="?xxx"` 的跳转锚点。

## 何时使用

使用流程标记块表达：

- action 的程序化执行流程。
- SKILL.md 的全局事件路由。
- actor 的 `drive.md`：该 actor 收到某类消息后如何分支、何时返回给主流程。
- 有明确控制语义的规则：硬闸、一次一动作、等待回执、重试、漂移再收敛、收口。

不要用流程标记块表达：

- 概念解释、术语定义、字段说明。
- JSON schema、卡片 markup、命令示例。
- 单纯的注意事项列表。

## 基本语法

写在 ```` ```text ```` 围栏里：

```text
@delimiter: --
@node: #
@marker: ?
-- #switch ?event on="当前输入 / 回执"
---- #case ?collect when="首次收到用户请求"
------ #step ?resolve
发起期望态补全动作；发出后停手等待回执。
------ /?resolve
---- /?collect
---- #case ?done when="实际态已收敛"
------ #return ?finish value="收口"
------ /?finish
---- /?done
-- /?event
```

规则：

- 开块格式：`<delimiter-depth> #node ?marker [key="value"]`。
- 闭块格式：`<same-depth> /?marker`。
- 每个块必须闭合，开闭的 `?marker` 必须一致。
- payload 顶格写自然语言，不需要缩进，不需要转义 `<...>`、`|`、`&`。
- 条件谓词是给 AI 读的自然语言，不是编译器表达式。

## 节点词汇

| 构造 | 用途 |
|---|---|
| `#switch` / `#case` / `#default` | 事件路由、状态分派、回执判因 |
| `#sequence` | 固定顺序执行的一组动作 |
| `#parallel` | 并行执行一组动作；可带 `limit` |
| `#step` | 单个动作或判断点 |
| `#if` / `#else-if` / `#else` | 局部分支 |
| `#loop` | 反馈循环、重试循环、reconcile loop |
| `#return` | 返回当前流程结果 |
| `#exit` | 发出动作后终止本回合，等待用户或工具回执 |
| `#goto` | 在同一流程块内跳到已命名锚点，慎用 |
| `#fail` / `#on-fail` | 明确失败和失败处理 |
| `#spawn` | 需要 fresh 子代理 / 独立执行者时使用 |
| `#call` | 调用另一个流程 / skill / SOP |

## SKILL.md 与 actor drive.md 的分工

- `SKILL.md` 写全局事件路由：先判硬闸，再按事件读取精确 paths，再发唯一真动作或等待。
- `actors/*/drive.md` 写 actor 内部局部流程：它收到什么、如何判断、返回什么给主流程。
- `contract.md` / `messages.md` 不承载复杂控制流；它们只定义契约和消息形状。

## 写法纪律

- 流程块里的每个 `#case` 只允许读取该 case 明确列出的 paths。
- 发出真动作后用 `#exit`，不要继续解释或追加第二个动作。
- 主流程等待外部回执时，明确写“等待什么回执”，避免 AI 自行用页面状态猜测。
- 复杂流程优先拆成“SKILL 全局路由 + actor 局部 drive”，不要把所有细节塞进一个巨大的流程块。
