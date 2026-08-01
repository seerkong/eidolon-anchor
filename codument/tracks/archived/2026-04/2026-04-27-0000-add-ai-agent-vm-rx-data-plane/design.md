## 上下文
本项目已有 `AgentEventGraph` 和 conversation domain runtime，但消费者仍需要知道具体来源。新增 public/private RxData 后，adapter、扩展和 sink 只依赖统一 public 数据面。

第一 Track 已经把 `AiAgentVm` 纯契约迁到 `ai-core-contract`，并在 VM 上预留 `publicRxData/privateRxData/publicRxBinding/privateRxBinding`。因此本 Track 不再负责“新增 VM 字段”，而是负责替换 contract 中的 `null` 占位类型，并在 `ai-core-logic` 中实现具体绑定。

## 方案概览
1. 类型层
  - contract 层 `AiAgentVmPrivateRxData`：内部可写 stream/signal 协议，不暴露 depa-data-graph class。
  - contract 层 `AiAgentVmPublicRxData`：只读 stream 与 readonly signal/projection 协议，不暴露 private writer。
  - `AiAgentVmRxBinding`：订阅与 cleanup 管理。
  - logic 层 runtime rx data factory：使用 depa-data-graph 创建实际 timeline/log/signal/projection。
2. 数据来源
  - semantic events 来自 `AgentEventGraph`。
  - history/prompt/session domain events 来自 conversation domain runtime，但该绑定应位于 organ/外层 adapter，不应让 `ai-core-logic` 直接 import `ai-organ-logic`。
  - usage 先提供 signal seam，后续由 LLM driver 或 token estimator 更新。
3. 生命周期
  - `createVM` 可继续创建空 rx seam；`ensureVmRxData` 负责惰性填充 private/public rx data 与 binding。
  - binding 在任何协议 adapter 订阅前创建。
  - binding dispose 幂等。

## 影响范围与修改点（Impact）
- 受影响的文件/模块：`ai-core-contract/src/runtime/AiAgentVm.ts`、`ai-core-logic/runtime`、`AgentEventGraph` 邻近测试、conversation domain runtime 订阅 seam。

## 决策摘要
- 详见 `decisions.md`
- 当前关键结论：字段名已由第一 Track 确认为 `publicRxBinding/privateRxBinding`；contract/logic 必须分离；contract 不直接依赖 depa-data-graph；首批 signal 先做 usage。

## 风险 / 权衡
- 过早迁移 domain runtime 会扩大风险 → core 只提供 optional binding seam，conversation domain 由 organ 层桥接现有 stream/listener。
- public 读面若泄漏 private 对象会破坏边界 → 类型测试与运行时封装共同约束。
- contract 若直接 import depa-data-graph，会破坏第一 Track 分层 → contract 只定义最小协议接口，logic 才使用具体实现。

## 迁移计划
1. 替换 contract 中 `AiAgentVmPublicRxData` / `AiAgentVmPrivateRxData` 的 `null` 占位。
2. 定义最小 stream/signal reader/writer 协议和 binding contract。
3. 在 `ai-core-logic` 实现 `ensureVmRxData` 或等价 runtime ops。
4. 接入 semantic event stream。
5. 提供 conversation domain optional binding seam，由 organ 层接入。
6. 增加 usage signal seam 与测试。

## 待解决问题
- usage 的真实更新来源。
- public readonly 类型的最适合 TypeScript 表达方式。
- 最小 stream/signal protocol 是否采用 subscribe/get/set/append 风格，还是复用 depa-data-graph 的类型别名但不引入实现类。
