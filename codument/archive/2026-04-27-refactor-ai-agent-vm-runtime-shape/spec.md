# 规范：refactor-ai-agent-vm-runtime-shape

## 概述

本 Track 重构 `AiAgentVm` 的字段设计，建立适配本项目双层微内核的标准运行时抽象。目标不是照搬参考项目的 `AIHarnessRuntime`，而是吸收其“运行时显式承载标准类别字段”的思想，同时避免 `AIHarnessControllerRuntime` 式历史字段堆积。

第一阶段目标结构如下（具体 RxData 类型由后续 Track 完成）：

```ts
export type AiAgentVm = {
  // actors
  controlActorKey: string;
  actors: Record<string, AiAgentActor>;
  actorRuntime: ActorRuntime<AiAgentVm, AiAgentMailboxSchema>;

  // AI holon / multi-agent collaboration runtime
  holonRuntime: AiHolonRuntime;

  // runtime knobs and side-effect boundaries
  options: RuntimeOptions;
  effects: RuntimeEffects;
  callbacks: RuntimeCallbacks;

  // non-rx data
  outerCtx: AiRuntimeOuterCtx;
  innerCtx: AiRuntimeInnerCtx;
  immutableSnapshot: AiRuntimeImmutableSnapshot;
  mutableSnapshot: AiRuntimeMutableSnapshot;

  // rx data
  eventBus: AgentEventGraph | null;
  publicRxData: AiAgentVmPublicRxData | null;
  privateRxData: AiAgentVmPrivateRxData | null;
  publicRxBinding: AiAgentVmRxBinding | null;
  privateRxBinding: AiAgentVmRxBinding | null;
};
```

说明：用户草案中的 `privateRxDBinding` 已确认为拼写问题，本 Track 统一规范为 `privateRxBinding`，不引入拼写型 API。`innerCtx`、`immutableSnapshot`、`mutableSnapshot` 是类别容器，首批字段按当前代码现状迁移；后续允许按类别继续扩充，但不得回退为无边界大杂烩。

## ADDED Requirements

### Requirement: AiAgentVm 必须显式表达标准运行时字段类别
系统必须在 `AiAgentVm` 类型层面表达 actors、holonRuntime、runtime knobs、non-rx ctx/snapshot 和 rx data 字段的所有权。

#### Scenario: 字段所有权可被静态阅读
- **GIVEN** 开发者打开 `AiAgentVm` 类型定义
- **WHEN** 查看字段与 ownership 常量
- **THEN** 必须能区分内层平台字段与外层 AI 领域字段
- **AND** 不需要通过 controller runtime 猜测字段归属

#### Scenario: actors 字段聚合
- **GIVEN** 开发者查看 `AiAgentVm`
- **WHEN** 需要理解 actor 运行能力
- **THEN** `controlActorKey`、`actors`、`actorRuntime` 必须位于 actors 分类
- **AND** actor 相关字段不得散落到 `holonRuntime` 或 snapshots 中

### Requirement: 多 AI 协作状态必须进入 AiHolonRuntime
系统必须新增 `AiHolonRuntime`，专属承载原多 AI 协作 / holon 相关状态，并吸收原 `aiFacet/sessionState/runtimeContext` 中对应字段。

#### Scenario: session/runtime context 通过 holonRuntime 同源访问
- **GIVEN** 现有代码仍通过 `ensureVmSessionState(vm)` 或 `ensureVmRuntimeContext(vm)` 访问状态
- **WHEN** VM 已按新结构创建
- **THEN** helper 必须从 `vm.holonRuntime` 返回对应对象
- **AND** 不得与 `vm.holonRuntime` 形成第二份状态

#### Scenario: holonRuntime 承载协作相关字段
- **GIVEN** 需要访问 member roster、holons、detached actors、orchestrator context 或 deferred resumes
- **WHEN** 选择字段位置
- **THEN** 这些字段必须归入 `AiHolonRuntime`
- **AND** 不得作为 `AiAgentVm` 顶层散列字段继续扩张

### Requirement: 内部上下文必须进入 AiRuntimeInnerCtx
系统必须新增 `AiRuntimeInnerCtx`，用于承载原 `registries`、`mcpManager`、`recovery` 等内部运行上下文。

#### Scenario: registries 迁移到 innerCtx
- **GIVEN** 现有代码需要访问 tool/skill/agent/mcp registries
- **WHEN** 字段结构完成迁移
- **THEN** 标准访问位置必须是 `vm.innerCtx.registries`
- **AND** 可以提供 `vm.registries` 兼容 facade，但不得成为长期主结构

#### Scenario: innerCtx 按类别扩充
- **GIVEN** 实现过程中发现新的内部运行上下文字段
- **WHEN** 该字段不属于 actors、holonRuntime、runtime knobs、snapshot 或 rx data
- **THEN** 可以归入 `AiRuntimeInnerCtx`
- **AND** 必须按子类别记录其生命周期与职责
- **AND** 不得把业务领域状态混入 innerCtx

### Requirement: VM 必须区分不可变与可变快照
系统必须新增 runtime snapshot 字段，以表达创建时固定事实与运行中可恢复事实。

#### Scenario: 创建 VM 时初始化 snapshots
- **GIVEN** `createVM` 被调用
- **WHEN** VM 创建完成
- **THEN** 必须存在 `immutableSnapshot`
- **AND** 必须存在 `mutableSnapshot`
- **AND** 二者边界必须在类型或注释中说明

#### Scenario: snapshot 按生命周期扩充
- **GIVEN** 实现过程中发现需要纳入 snapshot 的字段
- **WHEN** 字段代表 VM 创建时固定事实
- **THEN** 必须归入 `AiRuntimeImmutableSnapshot`
- **WHEN** 字段代表运行中可变且需要恢复/持久化的事实
- **THEN** 必须归入 `AiRuntimeMutableSnapshot`
- **AND** 不得把可变状态放入 immutable snapshot

### Requirement: aiFacet/sessionState/runtimeContext 必须形成兼容过渡
系统必须允许现有调用点继续读取 `aiFacet`、`sessionState`、`runtimeContext`、`registries`、`mcpManager`、`recovery`，但内部语义应收敛到 `holonRuntime` 或 `innerCtx`。

#### Scenario: 现有 ensure helpers 保持可用
- **GIVEN** 现有代码调用 `ensureAiRuntimeFacet(vm)`、`ensureVmSessionState(vm)` 或 `ensureVmRuntimeContext(vm)`
- **WHEN** VM 字段完成标准化
- **THEN** helper 必须返回与新字段一致的对象
- **AND** 不得创建彼此分叉的 session/runtime context

#### Scenario: 现有 registries 访问保持可用
- **GIVEN** 现有代码读取 `vm.registries`
- **WHEN** VM 字段完成标准化
- **THEN** 读取结果必须与 `vm.innerCtx.registries` 同源
- **AND** 修改兼容 facade 不得绕开 `innerCtx`

### Requirement: 第一阶段不得引入 controller-runtime 大杂烩
系统不得新增一个承载所有历史状态的大型 controller runtime 对象来模拟参考项目。

#### Scenario: 领域状态按类别归属
- **GIVEN** 需要挂载 conversation domain runtime、rx data 或 observability binding
- **WHEN** 选择字段位置
- **THEN** 必须按平台、AI 领域、响应式数据、可观测绑定等类别归属
- **AND** 不得新增一个无边界 `controllerRuntime` 字段承载所有内容

### Requirement: ai-core-contract 必须承载纯数据契约
系统必须将 `AiAgentVm`、runtime ctx/snapshot、registry 纯接口与 runtime snapshot persisted 类型等不执行副作用的契约定义放在 `cell/packages/ai-core-contract`，并让 `cell/packages/ai-core-logic` 只提供实现类、初始化逻辑与兼容 helper。

#### Scenario: contract 包不依赖 logic 包
- **GIVEN** 开发者检查 `cell/packages/ai-core-contract`
- **WHEN** 查看 package 依赖与源码 import
- **THEN** `ai-core-contract` 不得依赖或 import `@cell/ai-core-logic`
- **AND** 纯类型消费者必须能从 `ai-core-contract` 获取 VM 与 registry 数据契约

#### Scenario: logic 包实现 contract 包契约
- **GIVEN** `ai-core-logic` 需要创建 `AiAgentVm` 或 registry 实例
- **WHEN** 实现类和 `createVM` 引用 VM、ctx、snapshot 或 registry 形态
- **THEN** 必须复用 `ai-core-contract` 中的类型或接口
- **AND** 不得在 logic 包中维护第二套分叉的数据契约

#### Scenario: registry 数据与行为分离
- **GIVEN** `AgentRegistry`、`SkillRegistry`、`McpRegistry` 或 `ToolFuncRegistry` 需要被运行时持有
- **WHEN** 表达其状态与操作
- **THEN** `ai-core-contract` 必须提供不包含业务方法的 registry dataclass
- **AND** `ai-core-logic` 必须提供对应静态逻辑类
- **AND** 原实例方法必须迁移为以 dataclass 为第一个参数的静态方法

## 验收标准
- `AiAgentVm` 字段形态与 ownership 定义完成并有类型测试或单元测试覆盖。
- `createVM`、ensure helpers 与现有 actor runtime facet 兼容。
- `AiHolonRuntime`、`AiRuntimeInnerCtx`、snapshot 类型和 rx data 字段 seam 已定义。
- `innerCtx`、`immutableSnapshot`、`mutableSnapshot` 的字段扩充规则已在类型注释、文档或测试中体现。
- `ai-core-contract` 不再依赖 `ai-core-logic`，`ai-core-logic` 中的 VM、registry 与 runtime snapshot 类型复用 contract 包契约。
- registry 状态以 contract dataclass 存储，registry 行为以 logic 静态方法表达。
- 现有相关测试仍通过，至少覆盖 `ai-core-logic` 与依赖 `ensureVmRuntimeContext` 的 `ai-organ-logic` 用例。

## 范围外事项
- 不在本 Track 中实现完整 public/private RxData 数据面。
- 不在本 Track 中实现协议 adapter 或 observability sinks。
