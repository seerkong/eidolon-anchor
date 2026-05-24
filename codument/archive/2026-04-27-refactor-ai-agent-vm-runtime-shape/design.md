## 上下文
本项目当前 `AiAgentVm` 已经是 AI runtime 的主要承载点，但字段分类仍停留在 `PlatformRuntimeVm` 与 `AiRuntimeVmFacet` 的简单拆分。为了引入响应式数据面与观测能力，需要先稳定 VM 字段边界。用户已进一步指定第一阶段目标：`AiAgentVm` 顶层按 actors、holonRuntime、runtime knobs、非 rx data 与 rx data 分类。

## 方案概览
1. 标准化 `AiAgentVm` 一级分类
  - actors：`controlActorKey`、`actors`、`actorRuntime`。
  - holonRuntime：专属承载原多 AI 协作相关功能，吸收原 `aiFacet/sessionState/runtimeContext` 中对应字段。
  - runtime knobs：`options`、`effects`、`callbacks`。
  - non-rx data：`outerCtx`、`innerCtx`、`immutableSnapshot`、`mutableSnapshot`。
  - rx data：`eventBus`、`publicRxData`、`privateRxData`、`publicRxBinding`、`privateRxBinding`。
2. 新增核心类型
  - `AiHolonRuntime`：包含 `sessionState`、`runtimeContext`，并可继续细分 holon/session/orchestration 子结构。
  - `AiRuntimeInnerCtx`：首批包含 `registries`、`mcpManager`、`recovery`；后续可根据现状按类别继续扩充。
  - `AiRuntimeImmutableSnapshot`：创建时固定事实。
  - `AiRuntimeMutableSnapshot`：运行中可变/可恢复事实。
3. 保留兼容 facade
  - `aiFacet` 第一阶段可以作为 deprecated getter/facade 保留，但不再是主结构。
  - `sessionState`、`runtimeContext` getter/setter 从 `holonRuntime` 读写。
  - `registries`、`mcpManager`、`recovery` getter/setter 从 `innerCtx` 读写。
  - `privateRxDBinding` 不作为正式字段；统一使用 `privateRxBinding`。
  - `ensureAiRuntimeFacet`、`ensureVmSessionState`、`ensureVmRuntimeContext` 继续作为兼容入口。
4. 防止 controller 大杂烩
  - 不新增无边界 controller runtime。
  - 新字段必须进入 ownership 常量并注明类别。
5. 数据契约与运行逻辑分包
  - `ai-core-contract` 承载 `AiAgentVm`、actor/registry 纯接口、runtime ctx/snapshot 与 persisted snapshot 类型。
  - `ai-core-logic` 承载 `AgentRegistry`、`SkillRegistry`、`ToolFuncRegistry`、`McpRegistry`、`createVM`、ensure helpers 与 actor 创建等带实现或副作用边界的代码。
  - contract 包不得 import 或依赖 logic 包；logic 包通过类型别名和接口实现复用 contract 包契约。
  - registry 拆分为 contract dataclass 与 logic 静态类：`AgentRegistryData`、`SkillRegistryData`、`McpRegistryData`、`ToolFuncRegistryData` 持有数据；`AgentRegistry`、`SkillRegistry`、`McpRegistry`、`ToolFuncRegistry` 只暴露静态逻辑方法，原实例方法迁移为 `(data, ...args)` 形式。

## 影响范围与修改点（Impact）
- 受影响的文件/模块：`cell/packages/ai-core-contract/src/runtime/*`、`cell/packages/ai-core-contract/src/runtimeComposer.ts`、`cell/packages/ai-core-logic/src/runtime/runtime.ts`、`cell/packages/ai-core-logic/src/runtime/snapshot/types.ts`、相关 runtime tests、依赖 `ensureVmRuntimeContext` 的 organ logic tests。

## 决策摘要
- 详见 `decisions.md`
- 当前关键结论：采用用户指定的一级分类；`holonRuntime` 成为多 AI 协作主结构；`innerCtx` 承载 registries/MCP/recovery；旧顶层字段只作为兼容访问层。

## 风险 / 权衡
- 兼容 getter/setter 与 `holonRuntime/innerCtx` 可能分叉 → 通过单源初始化和 helper 测试约束。
- 字段类别过细增加复杂度 → 第一阶段只定义必要类别。
- snapshot 边界不清可能导致重复状态 → 第一阶段定义 `AiRuntimeImmutableSnapshot` / `AiRuntimeMutableSnapshot` 独立类型，并按生命周期分类扩展。
- `innerCtx` 扩充过度可能变成新大杂烩 → 每个新增字段必须归入明确子类别，并说明为什么不属于 holonRuntime/snapshot/rx data。

## 迁移计划
1. 增加类型测试描述当前兼容行为。
2. 新增 `AiHolonRuntime`、`AiRuntimeInnerCtx`、`AiRuntimeImmutableSnapshot`、`AiRuntimeMutableSnapshot` 与 rx seam 类型。
3. 调整字段 ownership 与 `createVM` 初始化。
4. 更新 helpers 与兼容 getter/setter，确保返回对象同源。
5. 将纯类型与端口接口移动到 `ai-core-contract`，移除 contract → logic 依赖。
6. 运行最小相关测试。

## 待解决问题
- `aiFacet` 的最终删除时间点。
- `immutableSnapshot/mutableSnapshot` 的首批字段清单。
- 后续 RxData 字段的确切类型命名。
