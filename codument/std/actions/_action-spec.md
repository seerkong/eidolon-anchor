# Action 提示词规范

codument 的每个 action 提示词放在 `codument/std/actions/<action>.md`。这些文件是 agent skill 壳引用的**权威 body**；skill 壳只负责 routing，真正规则、流程和示例都在 action body 中。

## 文档形态

- 默认使用普通 Markdown 写背景、规则、表格、示例、注意事项。
- 内嵌 XML / code 使用对应 fenced code block，例如 ```` ```xml ````。
- 程序化执行流程使用 flow notation 的 `text` 流程块。

flow notation 的权威规范见：

`codument/std/spec/flow-notation.md`

不要在每个 action 里重复完整 flow notation 说明；只在需要时引用该 spec。

## 何时使用流程块

当一段内容是明确控制流时使用流程块：

- 串行 / 并行步骤。
- 条件分支。
- 循环 / 重试 / 收敛。
- spawn 子代理。
- 等待回执。
- 返回 / 退出 / 失败处理。

当内容只是解释“是什么、为什么、注意什么、字段含义、示例”时，继续使用 Markdown prose。

## 引用约定

- 标准规范引用 `codument/std/spec/...`。
- 执行套路引用 `codument/std/methods/...`。
- 其他 action body 引用 `codument/std/actions/...`。
- action body 应自包含关键规则，不依赖聊天历史。

## 编写纪律

- action body 是给 AI 执行的，不只是人类文档；流程必须可恢复、可判定、可验证。
- 涉及外部状态的长流程，应明确状态真源，不依赖 chat history。
- 复杂 actor / 控制论流程优先拆成全局路由 + actor 局部 drive，不把所有细节塞进一个巨大流程块。
