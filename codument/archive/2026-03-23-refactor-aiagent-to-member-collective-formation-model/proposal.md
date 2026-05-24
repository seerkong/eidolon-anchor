# 变更：AIAgent 全面切换到 member / collective / formation actor 模型

## 背景和动机 (Context And Why)

当前 AIAgent 项目长期同时承载多套重构前概念层，组织语义、执行语义、命令语义和监听语义相互交叉，导致用户心智负担高、工具接口分裂、内部命名不统一，也让 vendor `depa-actor` 中面向 AI agent 的示例和说明无法稳定映射到一个清晰模型。

本变更要以 breaking change 方式，彻底切换到新的 actor 心智模型：组织层统一为 `member / collective / formation`，执行层统一为 `control actor / delegate actor / detached actor`，任务派发统一为 `assign`，监听控制统一为 `watch / unwatch`。目标不是增加一层兼容封装，而是完成全链路语义收口。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 将整个 AIAgent 项目的正式对象模型统一到 actor 体系
- 以 `member / collective / formation` 统一组织语义
- 以 `control actor / delegate actor / detached actor` 统一执行语义
- 在 runtime 中坚持组织语义与执行语义正交，member 通过 `identity.kind` 表达而不是复用 `control` type
- 将命令面统一为 `/actor`、`/member`、`/collective`、`/formation`
- 让底层 tool surface 直接跟随正式命令设计，而不是在已删除的旧工具族上做 rename wrapper
- 将任务派发统一为 `assign / assign:r / assign:n / assign:s`
- 将监听控制统一为 `watch / unwatch`
- 同步重写 runtime、tools、变量、持久化命名、测试与文档
- 重写 `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md` 及相关 AI agent 示例与模拟测试

**非目标:**
- 不兼容旧命令、旧 tool、旧变量名、旧文档名
- 不保留已删除旧命令空间作为 alias
- 不保留已删除旧工具族作为过渡封装
- 不兼容恢复旧 session、旧 snapshot、旧 indexes
- 不在旧模型上增加过渡层或双命名实现
- 不仅做文档改名而忽略内部实现重构

## 变更内容（What Changes）

- **BREAKING** 将正式对象模型切换为：
  - 组织语义：`member / collective / formation`
  - 执行语义：`control actor / delegate actor / detached actor`
- **BREAKING** 常规 member actor 在 runtime 中改为 `identity.kind="member" + actor.type="delegate"`，后台 member 改为 `identity.kind="member" + actor.type="detached"`
- **BREAKING** 将命令面切换为：
  - `/actor`
  - `/member`
  - `/collective`
  - `/formation`
- **BREAKING** 将底层 tool surface 直接改为命令对齐的 actor-native 工具族：
  - actor 核心工具：`ActorAssign`、`ActorStatus`、`ActorWatch`、`ActorUnwatch`
  - member 工具：`MemberCreate`、`MemberList`、`MemberAssign`
  - collective 工具：`CollectiveCreate`、`CollectiveAdd`、`CollectiveAssign`、`CollectiveStatus`
  - formation 工具：`FormationCreate`、`FormationAdd`、`FormationAppoint`、`FormationAssign`、`FormationStatus`
- **BREAKING** 将任务派发统一为：
  - `assign`
  - `assign:r`
  - `assign:n`
  - `assign:s`
- **BREAKING** 将监听控制统一为：
  - `watch`
  - `unwatch`
- **BREAKING** 将内部 tool、runtime 类型、metadata key、目录命名、测试命名和文档命名统一正名
- **BREAKING** 删除重构前旧工具族，而不是将其继续作为正式公开入口
- **BREAKING** 停止承诺对旧会话与旧持久化数据的兼容恢复
- 重写 AIAgent 相关说明文档与 howto，使正式文档只使用新模型
- 重写 `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md`
- 为 vendor `depa-actor` 补一套最小但完整的 AI agent 示例与模拟测试，体现新模型与新协议

## 影响范围（Impact）

- 受影响的功能规范：
  - AIAgent actor runtime
  - AIAgent 命令、控制动作、持久化与 terminal 交互
  - AIAgent 文档与 howto
  - vendor `depa-actor` 面向 AI agent 的文档、示例、模拟测试

- 受影响的代码与资产：
  - backend AIAgent runtime / persistence / tools / tests
  - builtin tool registry 与 command-aligned lower-level tool definitions
  - terminal core / tui / minimal 命令解析与交互
  - docs/ai/modules/AIAgent 下相关文档
  - vendor/depa-actor 下 AI agent 相关文档、示例和测试
