# AIAgent 最终命令规范

本文是 `member / collective / formation` 模型下的最终命令规范。后续命令实现、tool 命名和 TUI 交互应以本文为准。

## 1. 正式命令面

系统只保留以下一级命令：

- `/actor`
- `/member`
- `/collective`
- `/formation`

## 2. 正式对象模型

- `member`
  - 单个成员 actor

- `collective`
  - 无 leader 的自治组织 actor

- `formation`
  - 有 leader 的组织 actor

所有目标都统一视为 actor。

## 3. 对象引用规则

命令参数中的目标对象统一支持三种引用方式。

### 3.1 裸名字

默认、最推荐。

```text
/formation appoint alpha alice
/collective add research alice
/member assign alice :: review the persistence design
```

### 3.2 类型前缀

有歧义时使用。

```text
/formation appoint formation:alpha member:alice
/actor assign collective:research :: scan the repo
```

支持的前缀：

- `member:`
- `collective:`
- `formation:`

### 3.3 稳定 id

脚本化、跨重命名或需要绝对精确时使用。

当前正式稳定 id 前缀为：

- `member-`
- `collective-`
- `formation-`

```text
/formation appoint formation-123 member-456
/actor status collective-789
```

## 4. 统一动词系统

### 4.1 结构管理

- `create`
  - 创建对象
  - 适用于 `member`、`collective`、`formation`

- `list`
  - 列出对象

- `status`
  - 查看对象状态

- `add`
  - 建立成员加入组织的关系
  - 适用于 `collective add`、`formation add`

- `appoint`
  - 任命组织角色
  - 当前用于 `formation appoint`

### 4.2 任务派发

- `assign`
  - 给任意 actor 派发任务
  - 适用于 `member`、`collective`、`formation`

### 4.3 监听控制

- `watch`
  - 开启对象级持续监听

- `unwatch`
  - 关闭对象级持续监听

## 5. `assign` 的正式语义

`assign` 是唯一正式的任务派发动词。

### 5.1 三种模式

```text
assign   -> final
assign:r -> final
assign:n -> none
assign:s -> stream
```

含义如下：

- `assign`
  - 默认模式
  - request/response
  - 完成后返回最终结果

- `assign:r`
  - 显式指定 request/response 模式
  - 语义与默认的 `assign` 相同

- `assign:n`
  - 单向投递
  - 不等待回传

- `assign:s`
  - 流式回传
  - 执行过程中持续输出事件
  - 自动使目标进入 watched 状态

### 5.2 监听行为

- `assign:s` 不要求先执行 `watch`
- `assign:s` 在开始时就输出当前任务流
- `assign:s` 在任务结束后，目标继续保持 watched 状态
- 若不想继续接收该目标的后续事件，使用 `unwatch`
- 后续需要再次开启对象级持续监听时，使用 `watch`

### 5.3 为什么是这种设计

这套设计满足三个目标：

- 所有 actor 都只记一个派发动词 `assign`
- 三种回传模式都能保留
- 流式任务之后的后续事件可自然衔接到持续监听

## 6. `assign:s`、`watch`、`unwatch` 的边界

### `assign:s`

- 创建新任务
- 关注的是这次任务的执行流
- 同时让目标进入 watched 状态

### `watch`

- 不创建任务
- 只开启对象级持续监听
- 如果目标已处于 watched 状态，应视为幂等

### `unwatch`

- 不创建任务
- 只关闭对象级持续监听
- 不取消任务，不回滚状态

## 7. 正式命令清单

### `/actor`

```text
/actor assign <target> :: <content>
/actor assign:r <target> :: <content>
/actor assign:n <target> :: <content>
/actor assign:s <target> :: <content>
/actor status <target>
/actor watch <target>
/actor unwatch <target>
```

### `/member`

```text
/member create <name> [@agent_name] :: <prompt>
/member list
/member status <member_ref>
/member assign <member_ref> :: <content>
/member assign:r <member_ref> :: <content>
/member assign:n <member_ref> :: <content>
/member assign:s <member_ref> :: <content>
```

### `/collective`

```text
/collective create <name>
/collective add <collective_ref> <member_ref>
/collective assign <collective_ref> :: <task>
/collective assign:r <collective_ref> :: <task>
/collective assign:n <collective_ref> :: <task>
/collective assign:s <collective_ref> :: <task>
/collective status <collective_ref>
```

### `/formation`

```text
/formation create <name>
/formation appoint <formation_ref> <member_ref>
/formation add <formation_ref> <member_ref>
/formation assign <formation_ref> :: <task>
/formation assign:r <formation_ref> :: <task>
/formation assign:n <formation_ref> :: <task>
/formation assign:s <formation_ref> :: <task>
/formation status <formation_ref>
```

## 8. 推荐示例

### 8.1 Member

```text
/member create alice @code
/member assign alice :: summarize the bug
/member assign:s alice :: investigate and keep reporting progress
/actor unwatch alice
/actor watch alice
```

说明：

- `assign:s` 之后，`alice` 默认已处于 watched 状态
- 因此示例里先 `unwatch`
- 如果之后想重新开始接收 `alice` 的后续事件，再执行 `watch`

### 8.2 Collective

```text
/collective create research
/collective add research alice
/collective assign research :: scan the repo
/collective assign:s research :: implement the migration and report progress
/actor unwatch research
/actor watch research
```

### 8.3 Formation

```text
/formation create alpha
/formation add alpha alice
/formation appoint alpha alice
/formation assign alpha :: prepare an implementation plan
/formation assign:s alpha :: implement and keep reporting progress
/actor unwatch alpha
/actor watch alpha
```

## 9. 实现约束

后续实现应满足：

- `assign` 是唯一正式任务派发动词
- `assign` 默认等同于 `assign:r`
- `assign:s` 自动进入 watched 状态
- `watch / unwatch` 只控制对象级持续监听，不控制任务生命周期
- `watch` 应是幂等的
- `unwatch` 应是幂等的
- `unwatch` 不得被解释为 cancel、shutdown 或 interrupt
