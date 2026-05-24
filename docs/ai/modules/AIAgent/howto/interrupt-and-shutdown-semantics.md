# AIAgent 中断与关闭语义

本页说明 `cancel`、`shutdown` 与 TUI 双 `Esc` 的正式语义。

## 最终固定语义

### `cancel`

`cancel` = 停止当前调用 / 当前回合执行，但 actor 继续存在。

适合：
- 停止当前输出
- 保留当前主对话
- 后续继续协作

### `shutdown`

`shutdown` = 停止 actor 生命周期本身。

适合：
- 结束某个 member
- 结束某个 delegate / detached actor
- 把对象收口到退出态

## TUI 双 `Esc`

- control actor：`cancel`
- 当前短生命周期子任务：`shutdown`

也就是主会话保留，临时子任务退出。

## 在新对象模型里怎么理解

- `member` 收到 `cancel`
  - 只停当前调用
  - member 仍然存在

- `member` 收到 `shutdown`
  - member 退出生命周期

- `delegate / detached actor` 收到 `shutdown`
  - 结束这类短生命周期执行对象

## 与正式命令面的关系

- `/actor status|watch|unwatch`
  - 只是查询 / 监听，不涉及 `cancel` 或 `shutdown`

- `/member assign`、`/collective assign`、`/formation assign`
  - 是任务派发，不等于关闭对象

- shutdown / plan review / protocol status 等控制动作
  - 走正式工具能力
  - 不通过额外一级命令暴露

## 推荐记忆方式

> `cancel` 停当前回答，`shutdown` 停 actor 本身。

再加一句：

> TUI 双 `Esc` = 主会话 cancel，临时子任务 shutdown。
