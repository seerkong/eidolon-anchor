## 上下文

`vendor/depa-data-graph` 当前已经具备 graph、stream foundations 与部分 typed helper，但 identity model 仍然停留在“字符串键 + 类型包装”的层面。

这在三个方向上已经暴露出长期问题：

1. **局部命名无法成为正式边界**
   - 可以用对象常量收拢本地图节点名
   - 但外层仍能直接引用这些字符串，没有 module 级可见性约束
2. **派生图与实例化图没有正式 mount 模型**
   - 只能依赖 `"input/"`、`"computed/"`、`"processor/"` 等约定式前缀
   - 作用域与实例隔离靠人工拼字符串完成
3. **typed helper 只约束值类型，不约束身份结构**
   - `defineModel` / `createTypedGraph` 仍以扁平 `Record<string, ...>` 为前提
   - `deps` / `outputs` 依然是 `string[]`

如果继续沿着“把字符串集中管理得更好”演进，只会把问题从裸字符串迁移到全局常量或多层 enum，本质上仍没有解决 graph identity architecture。

## 方案概览

本 track 采用“模块化句柄系统”作为长期正式架构。

### 1. 引入结构化 identity primitive

在 vendor core 中新增以下长期概念：

- `NodeRef<TValue, TVisibility, TKind>`
- `PortRef<TValue, "input" | "output">`
- `InternalRef<TValue>`
- `GraphModule<TShape>`
- `MountedModule<TShape>`

核心原则：

- 上层代码主要操作 ref object，而不是字符串
- ref 携带值类型与可见性信息
- runtime 字符串 ID 由 mount/canonicalize 阶段生成

### 2. 引入 module shape 与公开边界

graph module 至少拆成三层：

- `inputs`: 允许外部写入或接线的入口
- `outputs`: 允许外部读取或接线的出口
- `internals` / `state`: 仅供模块内部使用的节点

这意味着：

- 子图是“组件”，不是扁平常量表
- 外层 wiring 默认只能使用公开端口
- 内部节点即使最终有 runtime canonical ID，也不自动成为正式外部契约

### 3. 引入 scope-aware mount

同一 `GraphModule` 应支持被多次实例化。

示意：

```ts
const StageModule = defineGraphModule("stage", {
  inputs: {
    lexicalEvents: input<LexicalEvent[]>(),
  },
  state: {
    lexicalSeq: state<number>(0),
  },
  outputs: {
    semanticEvents: output<SemanticEvent[]>(),
  },
});

const a = mountGraph(StageModule, { scope: "agent/main" });
const b = mountGraph(StageModule, { scope: "agent/reviewer" });
```

运行时可以得到类似 canonical ID：

- `agent/main::stage.inputs.lexicalEvents`
- `agent/reviewer::stage.inputs.lexicalEvents`

但这些字符串只作为 runtime/debug/serialization surface，不再是业务层直接维护的身份源。

### 4. Ref-first builder and runtime API

下列 API 需要以 ref 作为正式入口：

- `addSignal`
- `addComputed`
- `addProcessor`
- `addConsumer`
- `addAsync`
- `get`
- `set`
- `peek`
- `node`
- deps / outputs / bridge wiring

保留字符串兼容重载，但 ref-first 为正式推荐路径。

### 5. JSON DSL 与 codegen 收口

JSON DSL 不应长期成为“只会输出字符串 ID”的次等建图方式。长期方向应是：

- JSON DSL 定义 module shape 与 port visibility
- codegen 生成对应的 `NodeRef` / `GraphModule` surface
- runtime build path 仍可从 JSON 落图，但 identity abstraction 与 code-first 一致
- 对于由 signal 支撑的 public input/output，runtime build path 必须把这些 public ports 物化为真实 runtime node 或 bridge，而不是只在 generated surface 上暴露不可解析的别名 ref
- JSON spec 中保留的 raw node id 应能在落图时通过 generated identity map 解析到 module refs，而不是让 codegen surface 与实际 runtime node id 脱节

## 影响范围与修改点

### Vendor Core

- `packages/core/src/graph.ts`
  - 增加 ref-aware identity normalization
  - 为 `get/set/node` 等入口补 ref overload
- `packages/core/src/graph-builders.ts`
  - builder 定义改为支持 ref declaration 与 ref wiring
- `packages/core/src/typed-model.ts`
  - 从“字符串 schema 包装器”升级为能与 ref/module shape 对接的类型层
- `packages/core/src/typed-graph-v2.ts`
  - 从扁平 `Record<string, ...>` 走向 module-aware schema
- 新增 `packages/core/src/module-identity.ts` 或等价模块
  - 承载 `NodeRef`、`PortRef`、`GraphModule`、`mountGraph` 等正式能力

### JSON DSL / Codegen

- `tools/graph-codegen/src/*`
  - 输出 module-aware public surface
- graph JSON spec
  - 增加端口可见性、模块 shape 或 codegen 所需 metadata
  - `buildGraphFromJson` 或等价落图路径需要支持把 raw id、deps、outputs 与 async projection id 重写到 generated `GraphModule` refs

### Documentation / Examples

- 更新 architect 文档与 typed graph 示例
- 增加一个 subgraph/module 复用示例，展示多实例 mount 与公开端口 wiring

### Migration Pilots

- 前端 demo subgraph
- AI Agent 中至少一条明显受字符串命名影响的 graph 路径

## 关键决策

- 决策：不用全局 enum 作为正式长期方案
  - 理由：全局 enum 无法表达模块边界、实例作用域与派生图可组合性

- 决策：不用 `symbol` 直接作为公共 identity
  - 理由：`symbol` 不利于调试、序列化、日志、持久化与跨 DSL/codegen 对齐

- 决策：保留 canonical string，但将其降级为 runtime projection
  - 理由：runtime、日志、调试、持久化仍需要稳定文本标识，但不应让业务代码直接维护它

- 决策：module 默认隐藏 internals，只公开 inputs/outputs
  - 理由：这是避免上层依赖内层实现细节的必要边界

- 决策：字符串 API 继续兼容，但 ref-first 是正式长期路径
  - 理由：仓库已有大量字符串调用点，必须允许分阶段迁移

- 决策：JSON DSL / codegen 必须并入同一 identity model
  - 理由：如果 code-first 和 DSL-first 走两套身份体系，长期一定重新退回字符串互转

## 风险 / 权衡

- 风险：类型系统复杂度显著上升
  - 缓解：先定义最小稳定核心类型，只把复杂度集中到 vendor core，不扩散到业务调用点

- 风险：兼容层存在期间形成双轨 API
  - 缓解：文档、tests 与 examples 明确 ref-first 为正式路径；字符串重载只视为迁移层

- 风险：JSON DSL 的 module 化会扩大首轮改造面
  - 缓解：先落 identity core 与 code-first module，再补 DSL/codegen 收口任务，但在同一 track 中提前锁定目标模型

- 风险：过早暴露过多 mount/visibility 细节会固化坏 API
  - 缓解：先围绕最小场景设计：
    - 单模块定义
    - 多实例 mount
    - 父子 wiring
    - runtime canonical ID

## 兼容性设计

- 现有字符串 API 暂时保留
- 新增 ref overload 与 canonicalization 层
- 在迁移期间允许字符串与 ref 混用，但文档与示例统一切到 ref-first
- 待足够多的 usage 完成迁移后，再评估是否对字符串-only 路径做降级或 lint 化约束

## 迁移计划

1. 在 vendor core 中引入 `NodeRef` / `GraphModule` / mount 基础能力与 focused tests
2. 将 builder/runtime API 升级为 ref-aware，同时保留字符串兼容
3. 为 code-first graph 提供正式 module 示例，并迁移一个 subgraph 试点
4. 扩展 JSON DSL / codegen，使其输出相同 identity model
5. 在 AI Agent 与前端各选择一条路径做试点迁移
6. 补文档、focused tests、strict validation，并明确 compatibility boundary

## 待解决问题

- canonical runtime ID 的文本格式是否使用 `scope::module.path`，还是 `scope/module/path`
- `inputs/outputs/state/internals` 是否全部建模为不同 ref subtype，还是统一 `NodeRef` + metadata
- JSON DSL 首轮是直接表达 module，还是先由 codegen 对现有 flat JSON 做 module wrapper
- 是否需要为“只读 output”“只写 input”等端口权限提供更强的类型收窄
