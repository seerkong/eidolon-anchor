# 变更：AI Runtime Control 原语化改造

## 背景和动机 (Context And Why)
`add-runtime-snapshot-safepoints` 已经把 safepoint 判定从 snapshot writer 中移到 runtime helper，但这只是第一步。近期 actor surface lanes、heartbeat scheduler、questionnaire/TUI 控制面、mailbox wake 调度和 snapshot safepoint 都暴露了同一个结构性问题：`ai-organ-logic` 同时承担产品组合、AI runtime 控制面语义、actor mailbox 分类、durable signal 恢复、barrier 判定和 durable head 推进。

本项目吸引子要求 vendor 原语优先和双层微内核架构。因此本 track 将控制面一致性拆成两层：底层业务无关原语放入项目根目录下的 `vendor/depa-actor-control`，AI 领域原语放入 `cell/packages/ai-runtime-control-contract` 与 `cell/packages/ai-runtime-control-logic`。`ai-organ-logic` 后续只保留组合、binding、profile overlay、工具注册和 facade 编排职责。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 在 `vendor/depa-actor-control` 中定义业务无关 actor 控制面原语：control operation、control signal log、mailbox work classification、control barrier、durable head cohort。
- 新增 `cell/packages/ai-runtime-control-contract`，定义 AI runtime 控制面 contract：AI mailbox policy、AI turn barrier、AI control operation、AI durable head cohort。
- 新增 `cell/packages/ai-runtime-control-logic`，实现 AI runtime 控制面逻辑，并依赖 `depa-actor-control` 与现有 AI core contract。
- 将当前 safepoint helper 迁入 AI runtime control 层，并删除 `ai-organ-logic` 中的旧兼容导出。
- 为 heartbeat、questionnaire、actor surface、TUI actor 操作等后续迁移建立明确 seam，但本 track 只迁移最小热路径。
- 按 TDD 方式补充 vendor 原语、AI control layer 和 safepoint 迁移回归测试。

**非目标:**
- 不把 AI tool-call、questionnaire、member/delegate/holon 等领域语义下沉到 `vendor/depa-actor-control`。
- 不替换 `depa-actor`，也不重新实现 actor/fiber/mailbox 基础设施。
- 不在本 track 中完整迁移 heartbeat、actor surface、questionnaire/TUI facade 的所有实现。
- 不把 `ai-organ-logic` 清空；它仍负责产品组合、profile 绑定、工具注册和外部 facade。
- 不扩展 `AiAgentVm` / `VmRuntimeContext` 去承载控制面诊断 payload。
- 不保留旧 safepoint shim、兼容 re-export 或跨包相对 `../src` 导入。

## 变更内容（What Changes）
- 新增 vendor package：`vendor/depa-actor-control`。
- 新增 AI domain packages：`cell/packages/ai-runtime-control-contract`、`cell/packages/ai-runtime-control-logic`。
- 更新 workspace/package dependency，使 `ai-runtime-control-logic` 可以依赖 `depa-actor-control`，`ai-organ-logic` 可以依赖 AI runtime control layer。
- 跨 package 调用全部切换为 package name import，禁止通过相对路径访问其他 package 的 `src`。
- 将 `AiRuntimeSnapshotSafepoint` 中的 blocker 类型、AI mailbox 分类和 checker 迁移到 AI runtime control layer。
- 将 `RuntimeSnapshots` 与 `AiAgentRuntimeCoordinator` 改为调用 AI runtime control layer，而不是直接持有 safepoint 判断实现。
- 删除 `ai-organ-logic/src/runtime/AiRuntimeSnapshotSafepoint.ts` 旧 shim，`RuntimeSnapshots` 不再 re-export safepoint API。
- 增加 spec delta、测试和实现文档，明确 vendor 原语、AI 领域原语、organ 组合层三者边界。

## 影响范围（Impact）
- 受影响的功能规范：`vendor-actor-runtime-foundations`、新增 `vendor-actor-control-primitives`、新增 `ai-runtime-control-primitives`、`aiagent-persistence-recovery`、`aiagent-fiber-orchestration`。
- 受影响的代码区域：`vendor/depa-actor-control`、`cell/packages/ai-runtime-control-contract`、`cell/packages/ai-runtime-control-logic`、`cell/packages/ai-organ-logic/src/runtime`、`cell/packages/ai-organ-logic/src/persistence`、相关 package/workspace 配置与测试。
