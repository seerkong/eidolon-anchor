## 上下文

当前项目已经完成了 actorization 主路径收口，并把部分低层能力下沉到 `symbiont-*`。下一阶段的最高收益前置工作，不是继续先做组合面，而是先把 data-plane 中真正通用的 stream/timeline/projection 机制沉淀到 vendor。

当前状态存在三层边界问题：

1. `vendor/depa-data-graph` 只有基础 stream graph / bridge 能力
  - 已有 `StreamGraph`、`GraphBridge`、`signalToStream`、`subscribeStreamToSignal`
  - 但 ordered timeline、append-only event log、reducer projection 还没有成为正式 vendor surface
2. `symbiont-*` 仍维护平行的低层 stream helper
  - `cell/packages/symbiont-contract/src/stream/stream.ts`
  - `cell/packages/symbiont-logic/src/stream/IngressStreams.ts`
  - `cell/packages/symbiont-logic/src/stream/IngressStreamRuntime.ts`
3. `core/organ/terminal` 仍手工实现通用事件日志和 projection dispatch
  - `cell/packages/core-logic/src/stream/AgentEventGraph.ts`
  - `terminal/packages/organ/src/stream/*`

如果不先做这一层，后续微内核改造会继续建立在项目自定义 data-plane helper 上，vendor 无法成为稳定基座。

## 方案概览

1. 在 `vendor/depa-data-graph` 中补齐正式的 timeline/log/projection primitive
  - ordered timeline
  - tee/fanout
  - append-only event log
  - reducer/projection builder
2. 让 `symbiont-*` 的 ingress runtime 收口到 vendor primitive
  - 低层 stream helper 变为 vendor foundation 上的薄封装，或被直接删除
3. 让 `core/organ/terminal` 的通用事件日志与 projection dispatch 收口到 vendor foundation
  - 尤其是 `AgentEventGraph` 的 `latest_event + event_seq` 模式
  - 对可复用的 stateful projection，优先切到 vendor `ReducerProjection`
  - 对仅负责表现层格式化或 UI event 发射的薄 listener，允许继续作为 vendor event log 之上的 presentation adapter
4. 严格保留 AI-specific 语义在 `symbiont-*` 与上层
  - vendor 只承接通用机制，不承接 lexical/syntactic/semantic 命名与 transcript 约定

## 影响范围与修改点

### Vendor Foundations
- `vendor/depa-data-graph/packages/core/src/stream/index.ts`
- `vendor/depa-data-graph/packages/core/src/stream/stream-graph.ts`
- `vendor/depa-data-graph/packages/core/src/stream/stream-factories.ts`
- `vendor/depa-data-graph/packages/core/src/stream/*` 下新增 timeline/log/projection 相关实现
- `vendor/depa-data-graph/packages/core/test/*`
- `vendor/depa-data-graph/README.md` 或 vendor 内相关 stream 文档

### Symbiont Convergence
- `cell/packages/symbiont-contract/src/stream/stream.ts`
- `cell/packages/symbiont-logic/src/stream/IngressStreams.ts`
- `cell/packages/symbiont-logic/src/stream/IngressStreamRuntime.ts`
- `cell/packages/symbiont-logic/src/stream/index.ts`

### Core / Organ / Terminal Cutover
- `cell/packages/core-logic/src/stream/AgentEventGraph.ts`
- `cell/packages/core-logic/src/stream/MessageHistoryGraph.ts`
- `cell/packages/organ-logic/src/stream/*`
- `terminal/packages/organ/src/stream/*`

## 决策

- 决策：vendor 只沉淀通用 data-plane 机制
  - 理由：vendor 需要同时服务 AI 与前后端场景，不能把 AI stage 语义直接写死进基础库

- 决策：先收口 `symbiont-*`，再收口 `core/organ/terminal`
  - 理由：`symbiont-*` 是项目中最接近通用低层 stream foundation 的一层，先收口这里可以降低后续 cutover 的扩散面

- 决策：允许短期 adapter，但不允许双正式真相源长期共存
  - 理由：迁移期可能需要兼容封装，但 track 目标是让 vendor 成为正式来源，而不是再增加一层永久 wrapper

- 决策：`AgentEventGraph` 这类通用事件日志语义优先迁到 vendor primitive
  - 理由：它当前本质上已经在模拟 append-only event log 与 projection dispatch，属于应当下沉的通用机制

- 决策：对 terminal/core 中“真正维护共享状态”的 projection，优先切到 vendor `ReducerProjection`
  - 理由：这类模块已经具备标准 reducer-style projection 形态，继续保留项目内私有 substrate 会削弱 vendor 单源目标

- 决策：`TuiProjectionGraph`、`TextualProjectionGraph` 等 presentation listener 不强制在本 track 中改写为 reducer projection
  - 理由：它们主要承担 UI 文本/控制事件发射，而不是共享状态快照真相源；本 track 的优先级应放在可复用 stateful projection 的正式收口

- 决策：AI-specific semantic / transcript / tool-call 语义继续保留在 `symbiont-*` 与上层
  - 理由：这些能力复用价值高，但语义明显属于 AI 领域，不应污染 vendor 边界

## 风险 / 权衡

- 风险：vendor surface 设计得过于贴近当前 AI runtime
  - 缓解：tests 和 API 命名只围绕 timeline/log/projection 的通用行为，不引入 lexical/syntactic/semantic 领域词汇

- 风险：`EventEmitter` 风格 helper 向 vendor foundation 迁移时出现行为细节漂移
  - 缓解：先补 vendor 与 symbiont focused tests，再进行 cutover

- 风险：`core/terminal` 收口时暂时出现两套通用事件来源
  - 缓解：将 adapter 明确定义为过渡层，并在最后 phase 扫描删除长期双轨 helper

- 风险：把所有 terminal presenter 都强行 reducer 化会扩大本 track 范围
  - 缓解：优先收口 `MessageHistoryGraph`、`TuiTextGraph` 这类共享状态 projection；将纯 presentation emitter 继续视为 vendor event log 上层 adapter

- 风险：terminal projection 改造范围外溢到更高层交互协议
  - 缓解：本 track 只收口其底层通用 event/log/projection 依赖，不改写上层产品协议

## 兼容性设计

- 本 track 以内部 breaking-change 收口为主
- 对外 AI-specific contract 尽量保持稳定
- 如需保留旧 helper 名称，只允许它们成为 vendor primitive 上的薄适配层
- 迁移完成后，旧 helper 不再作为正式通用来源

## 迁移计划

1. 冻结 track 边界，并将实现范围具体化到 vendor、symbiont、core/terminal 三层
2. 先在 vendor 中建立 timeline/log/projection primitive 与 focused tests
3. 再迁移 `symbiont-*` ingress foundations 到 vendor primitive
4. 再迁移 `core/organ/terminal` 的通用 event graph / projection dispatch
   - 先完成共享状态 projection 的 vendor `ReducerProjection` cutover
   - 再把残留 presenter 与 facade 的边界写清，避免误判为第二套正式 substrate
5. 最后执行回归验证、删除双轨 helper，并通过 `codument validate --strict`

## 待解决问题

- vendor 的正式 API 命名应尽量贴近现有 `stream/*` 风格，还是显式拆成 timeline/log/projection 三组导出
- `AgentEventGraph` 是否只收口通用 event log / projection 机制，还是顺带让 `MessageHistoryGraph` 一并共享同一底层 primitive
- `symbiont-contract/src/stream/stream.ts` 是保留为兼容 facade，还是直接删掉并统一迁到 vendor import surface
