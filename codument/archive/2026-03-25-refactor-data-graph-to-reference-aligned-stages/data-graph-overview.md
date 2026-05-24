# Data Graph Stream Refactor Proposal

## Goal

本 track 的目标是将本项目历史上的压缩流式链路，收敛为三层事件模型：

1. `lexical`
2. `syntactic`
3. `semantic`

但底层承载方式不回退到参考项目中基于 Rx/stream object 的实现，而是继续以本项目现有的 `DataGraph` 为核心执行模型。

## Hard Constraints

这次改造有四个不可妥协的约束：

1. 事件定义以参考项目为准。
2. 事件产生时机以参考项目为准。
3. 事件构造字段与命名以参考项目为准。
4. P1 必须先冻结契约与测试闭环，随后按 breaking-change 路线直接切到新链路。

这意味着：

- 不能只“借鉴思想”然后继续保留压缩式旧事件面。
- 不能继续把 lexical 和 syntactic 隐含在单个语义 graph 内部。
- 不能用“兼容旧字段名”的方式替代严格对齐。
- 在契约与测试 gate 通过后，应直接切换到新链路，而不是长期保留双轨。

## Phase Deliverables

### P1: Contract Freeze & Guardrails

第一阶段只冻结规范与边界，不直接宣称完成 pipeline / projector 实现：

1. 完全新建 lexical / syntactic / semantic 事件定义
2. 冻结 transcript naming
3. 建立 phase-1 约束与旧入口防护测试
4. 形成可直接对照参考项目源码的字段映射与构造规则对齐表

### P2-P5: Semantic-First Implementation, Validation, and Cleanup

后续阶段再逐步完成：

1. 正式 stage-based DataGraph
2. semantic-first runtime bus
3. TUI / Textual / card / text 消费 graph 和测试
4. 全链路验证 gate
5. 删除旧压缩路径与兼容残骸

## Standard Document References

本 track 的标准文档会引用以下自包含补充文档：

1. `./data-graph-context.md`
2. `./data-graph-architecture.md`
3. `./data-graph-migration.md`
