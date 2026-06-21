# 变更：重构 AiAgentVm 标准运行时字段形态

## 背景和动机 (Context And Why)
参考项目通过 `AIHarnessRuntime` 暴露 public/private rx data 与运行时绑定，但仍遗留 `AIHarnessControllerRuntime` 字段过多的问题。本项目的 `AiAgentVm` 已经承担 AI runtime 入口职责，并且存在双层微内核边界：内层是领域无关系统，外层是 AI 领域微内核。因此第一步应先重构 `AiAgentVm` 字段形态，明确哪些字段属于 actors、holonRuntime、runtime knobs、inner/outer ctx、snapshots 与未来响应式数据面。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 明确 `AiAgentVm` 的标准字段类别与 ownership。
- 新增 `AiHolonRuntime`，将原 `aiFacet`、`sessionState`、`runtimeContext` 中多 AI 协作相关能力归入该对象。
- 新增 `AiRuntimeInnerCtx`，将原 `registries`、`mcpManager`、`recovery` 归入内部上下文。
- 新增 `immutableSnapshot` 与 `mutableSnapshot` 字段，区分创建时固定事实与运行中可恢复事实。
- 允许 `innerCtx`、`immutableSnapshot`、`mutableSnapshot` 根据当前代码现状继续按类别扩充。
- 将 `aiFacet`、`sessionState`、`runtimeContext`、`registries` 等旧访问方式统一为兼容过渡层，避免状态分叉。
- 为后续 `publicRxData`、`privateRxData`、`publicRxBinding`、`privateRxBinding` 预留标准挂载点。
- 保持 `createVM` 与现有 ensure helpers 的兼容性。
- 将 `cell/packages/ai-core-logic` 中的纯类型、接口与副作用端口定义迁移到 `cell/packages/ai-core-contract`，使 contract 承载数据契约、logic 承载运行逻辑。

**非目标:**
- 不一次性实现所有 RxData 类型与流绑定。
- 不新增 `AIHarnessControllerRuntime` 式 controller 大对象。
- 不迁移所有 organ/domain 状态。

## 变更内容（What Changes）
- 调整 `cell/packages/ai-core-logic/src/runtime/runtime.ts` 中 `AiAgentVm` 类型与 ownership 常量，形成如下一级分类：actors、holonRuntime、options/effects/callbacks、outer/inner ctx、snapshots、rx data。
- 更新 `createVM` 的初始化逻辑，使兼容字段与 `holonRuntime` / `innerCtx` 保持同源。
- 将用户草案中的 `privateRxDBinding` 规范为 `privateRxBinding`。
- 将 `mutableSnapshot` 类型规范为 `AiRuntimeMutableSnapshot`，与 `AiRuntimeImmutableSnapshot` 区分。
- 为后续 RxData 字段命名和类别留出类型 seam。
- 移动 `AiAgentVm`、runtime ctx/snapshot 类型、registry 纯接口与 runtime snapshot persisted 类型到 `ai-core-contract`，并让 `ai-core-logic` 只保留实现类、初始化函数与兼容 helper。
- 将 registry 拆为 contract dataclass 与 logic 静态类，原实例方法迁移为以 dataclass 为第一个参数的静态方法。
- 移除 `ai-core-contract` 对 `ai-core-logic` 的类型依赖，防止 contract 包重新引用 logic 包形成数据/逻辑倒置。

## 影响范围（Impact）
- 受影响的功能规范：AI runtime VM 创建、actor runtime facet、session state、runtime context、后续响应式数据面。
