# AIAgent 组织模型关系说明

本文从多个视角描述 `control actor`、`member`、`collective`、`formation`、`delegate actor`、`detached actor` 之间的关系。

## 1. 从统一 actor 视角看

在新模型中，系统中的主要对象都应统一投影为 actor。

```text
Workspace / Session
└── Control Actor
    ├── Member Actors
    ├── Collective Actors
    ├── Formation Actors
    ├── Delegate Actors
    └── Detached Actors
```

这意味着：

- 对外发送任务时，目标都可以被看作一个 actor
- 对外观察状态时，目标都可以暴露统一的 actor 状态接口
- 对外订阅事件时，目标都可以暴露统一的事件流接口

这里的“actor”首先指正式心智模型与正式接口，而不强制要求当前 runtime 中每个组织对象都已经注册为独立 fiber-backed actor。

当前实现中：

- `member` 是 runtime 中的实际 actor
- `collective` / `formation` 通过 organization state + actor-like projection 暴露统一 `assign / status / watch / unwatch` 接口

因此，当前正式边界应理解为：

- organization object 是 actor-addressable target
- formal surface 统一按 actor 操作
- runtime 是否为其分配独立 fiber-backed actor，属于实现策略而不是当前文档默认前提

## 2. 从人与组织视角看

### `member`

- 是组织中的个人
- 可以同时加入多个 `collective`
- 可以同时加入多个 `formation`
- 可以被直接分配任务
- 也可以通过组织间接接到任务

### `collective`

- 是无固定 leader 的自治组织
- 自己对外表现为一个 actor
- 当前实现中的正式 membership 关系只覆盖 `member`
- `collective` / `formation` 级别的嵌套仍属于后续演进方向，不应被当作当前已落地能力
- 核心行为是基于任务板、领取、优先级、调度规则推进工作

### `formation`

- 是有 leader 的组织
- 自己对外表现为一个 actor
- 当前实现中的正式 membership 关系只覆盖 `member`
- `collective` / `formation` 级别的嵌套仍属于后续演进方向，不应被当作当前已落地能力
- 核心行为是由 leader 或 leader 代表的协调层进行决策、拆分、派发和汇总

## 3. 从嵌套关系视角看

从目标模型上看，`collective` 和 `formation` 最终应支持嵌套；但当前实现尚未把 organization membership 扩展到 `member` 之外。

```text
Control Actor
└── Formation Alpha
    ├── Member Alice
    ├── Member Bob
    ├── Collective Research
    │   ├── Member Carol
    │   └── Formation Review
    │       ├── leader: Member Dave
    │       └── Member Erin
    └── Collective Execution
        ├── Member Frank
        └── Collective Tooling
```

推荐遵循以下规则：

- `member` 可以加入多个组织
- 当前已实现：`collective` 可以包含多个 `member`
- 当前已实现：`formation` 可以包含多个 `member`
- 规划中但尚未落地：`collective -> collective`
- 规划中但尚未落地：`collective -> formation`
- 规划中但尚未落地：`formation -> collective`
- 规划中但尚未落地：`formation -> formation`

## 4. 从运行语义视角看

组织语义和执行语义应解耦。

### 组织语义

- `member`
- `collective`
- `formation`

### 执行语义

- `control actor`
- `delegate actor`
- `detached actor`

其中：

- `member` 可以是某个 actor 的 delegate actor
- `formation` 内部也可以派生自己的 delegate actor
- `collective` 可以创建 detached actor 处理长任务

因此，执行语义不是对组织语义的替代，而是另一条正交维度。

## 5. 从任务流视角看

### 直接发给 `member`

```text
Control Actor -> Member
```

特点：

- 路径最短
- 语义最明确
- 适合点对点要求

### 发给 `collective`

```text
Control Actor -> Collective -> claimed by member(s)
```

特点：

- 任务先进入共享任务板或自治调度器
- 由领取机制、优先级或调度规则决定谁来做
- 对外看起来像一个 actor，在内部再自治分发
- 对外仍应支持 `reply_mode = none | final | stream`

### 发给 `formation`

```text
Control Actor -> Formation -> leader -> members
```

特点：

- 任务先到有 leader 的组织 actor
- 由 leader 进行拆分、决策和汇总
- 适合需要集中判断、统一风格或统一取舍的场景
- 对外仍应支持 `reply_mode = none | final | stream`

## 6. 从回传协议视角看

不论目标是 `member`、`collective` 还是 `formation`，都应支持统一的业务级回传模式。

### 单向发送

- 调用方只负责投递
- 不等待完成
- 适合广播、触发、异步通知

### 完成后回传

- 调用方等待最终结果
- 目标在完成或失败时返回结论
- 适合把对方当成一个 RPC 风格 actor

### 事件流回传

- 调用方在执行过程中持续收到事件
- 适合长任务、编排过程、可视化进度
- 语义类似 SSE，但属于业务封装层协议

推荐统一抽象为：

```text
reply_mode = none | final | stream
```

在命令层，建议统一映射为：

```text
assign:r -> final
assign   -> final
assign:n -> none
assign:s -> stream
```

- `assign` 是默认的 request/response 形式
- `assign:r` 是对同一语义的显式写法

而对象监听语义建议映射为：

```text
watch   -> enable actor event subscription
unwatch -> disable actor event subscription
```

两者区别是：

- `assign:s` 是某次任务调用的过程流，并默认使目标进入 watched 状态
- `watch` 是对象级的持续观察流
- `unwatch` 用于关闭对象级持续观察流
- `watch / unwatch` 不会创建任务

## 7. collective 的任务推进

在正式模型下，组织级任务推进属于 `collective` 行为。

更准确的定义是：

- `collective` 通过共享任务板与组织内调度来推进工作
- 其内部可以由成员自领取任务，也可以由匿名协调 actor 辅助调度

因此：

- 任务推进是组织行为
- collective 是组织名词
- dispatcher 是实现细节

## 8. 从 leader 视角看

在 `formation` 中，leader 应被视为组织能力的一部分，但不一定等于某个“唯一实现方式”。

可选实现包括：

- 由某个 `member` 担任 leader
- 由 leader member 加协调协议共同承担
- 由专门的协调 actor 代表 leader 行为

关键不在于实现细节，而在于对外语义：

- `formation` 对外必须表现出“存在 leader 决策点”
- `collective` 对外必须表现出“没有固定 leader，由自治机制推进”

## 9. 从系统层级视角看

```text
Actor Layer
├── Control Actor
├── Member
├── Collective
├── Formation
└── Detached Actor

Organization Layer
├── Membership
├── Collective nesting
└── Formation nesting

Execution Layer
├── Direct messaging
├── Actor watching
├── Delegate actor spawning
├── Detached execution
└── Task-board dispatch

Protocol Layer
├── one-way
├── final reply
└── event stream
```

这套分层的核心价值是：

- 避免“名字在不同层表示不同意思”
- 让组织模型、执行模型、消息协议分别演进
- 让未来的无限嵌套组织树保持语义稳定
