# 变更：重构 vendor data-graph 的模块化节点标识系统

## 背景和动机

当前 `vendor/depa-data-graph` 的 graph node、deps、outputs 与 `get/set` 入口主要以字符串 ID 作为正式标识。现有 typed helper 能约束值类型，但不能约束图实例化、派生图、子图暴露边界与跨层 wiring 时的身份模型。

在前端与 AI Agent 两类使用场景里，这会带来同一类长期问题：

- 裸字符串在重构时容易失配，特别是 `deps`、`outputs`、`ctx.get/set` 这类跨多点引用
- 子图与派生图需要自己的局部命名空间，但当前只有“约定式字符串前缀”，没有正式的层级/可见性模型
- 外层组合代码可以直接依赖内层内部节点，难以稳定形成 `inputs/outputs` 契约
- JSON DSL、Code DSL 与 runtime API 虽然都能建图，但共享的仍是扁平字符串身份，而不是统一的模块化标识抽象

这个问题已经不是“常量放哪里更方便”，而是 vendor graph 缺少一套可长期演进的 node identity architecture。

## “要做”和“不做”

**目标：**
- 在 `vendor/depa-data-graph` 中建立正式的模块化节点标识系统，以结构化 `NodeRef` / `PortRef` 取代裸字符串作为一等 graph identity
- 为 graph module / subgraph / derived graph 提供显式 `inputs/outputs/internals` 分层与作用域化 mount 能力
- 让 builder、runtime API 与 codegen/JSON DSL 收口到同一套 identity model
- 保持 vendor identity layer 通用、可跨前端与 AI Agent 复用，不引入 AI-specific 语义
- 为现有字符串 API 设计受控兼容层与迁移顺序，避免一次性硬切导致仓库级震荡

**非目标：**
- 不在本 track 中重写 AI-specific lexical/syntactic/semantic 合约
- 不在本 track 中处理 timeline / event-log / projection primitive 的语义扩展；这些能力已由既有 stream foundations track 负责
- 不要求首轮实现中把仓库所有 graph 使用点一次性迁完
- 不把 vendor public surface 变成依赖全局 enum 或集中式命名表的设计

## 变更内容（What Changes）

- 在 vendor core 中新增结构化 node identity primitive，例如 `NodeRef`、`PortRef`、`GraphModule`、`MountedModule`
- 为 graph module 定义正式的公开端口和内部节点边界：`inputs`、`outputs`、`state/internals`
- 为图实例化提供 scope-aware mount 机制，使同一模块可被多次实例化并获得稳定、可序列化的 canonical runtime ID
- 让 `addSignal`、`addComputed`、`addProcessor`、`addConsumer`、`get/set/peek/node`、deps/outputs 声明支持 ref-first 调用方式
- 扩展 JSON DSL / codegen，使其生成或消费与 code-first 一致的模块化 identity model，而不是继续只输出扁平字符串键
- 补充 focused tests、文档与迁移策略，锁定兼容边界

## 影响范围（Impact）

- 受影响的功能规范：
  - `vendor-data-graph-modular-node-identity`（新增 capability）
  - `vendor-data-graph-stream-foundations`（需要保持 API 与 layering 一致，但不在本 track 中重写其 requirements）
- 受影响的代码：
  - `vendor/depa-data-graph/packages/core/src/graph.ts`
  - `vendor/depa-data-graph/packages/core/src/graph-builders.ts`
  - `vendor/depa-data-graph/packages/core/src/typed-model.ts`
  - `vendor/depa-data-graph/packages/core/src/typed-graph-v2.ts`
  - `vendor/depa-data-graph/tools/graph-codegen/*`
  - `vendor/depa-data-graph/doc/architect/*`
  - 后续迁移试点将触达 AI Agent 与前端 demo 的 graph usage

## 成功标准

- vendor 提供正式、可复用的模块化 node identity abstraction，而不是继续以裸字符串作为唯一一等身份
- 外层组合代码默认只能通过 module `inputs/outputs` 连线，不能无约束依赖子图内部节点
- 同一 graph module 可安全多实例化，且不会依赖全局枚举池来解决命名冲突
- Code DSL、runtime API、JSON DSL / codegen 对 node identity 的建模收敛为同一套长期架构
- 文档、计划和 focused tests 足以支撑后续分 phase 实施与迁移
