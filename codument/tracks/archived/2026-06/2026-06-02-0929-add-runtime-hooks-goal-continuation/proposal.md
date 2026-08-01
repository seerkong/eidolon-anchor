# 变更：添加 runtime lifecycle hook 并用其驱动 goal continuation

## 背景和动机 (Context And Why)
本项目已经有 manifest/profile 机制，用来把默认 runtime 能力从 terminal 等入口迁移到 module extension。但模块 extension/manifest 类型还缺少 lifecycle hook 字段，导致 goal 自动续接这类生命周期能力只能放在 `ai-organ-logic` 的 background pump 轮询里。

goal 的理想语义接近 Codex 的 `MaybeContinueIfIdle`：当 thread 空闲且没有更高优先级输入时继续推进。它应该是 runtime 生命周期上的可组合 hook point，而不是固定 50ms 轮询中的硬编码特例。对齐 Sparrow 后，本 track 不把 idle 设计成特殊事件枚举，而使用 `domain.action.phase` 字符串点位，例如 `actor.idle.before`，未来可承载 memory flush、member coordination、diagnostics、compaction eligibility 等能力。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 新增 first-class hook extension type，作为现有模块级 manifest/extension 的 `hooks` 字段进入 runtime assembly，不另建 hook 注册链路。
- hook contract 对齐 Sparrow：point 是 `domain.action.phase` 字符串，mode 是 `observe/transform/decision/around`，action 是 `continue/replace/deny/ask/retry/stop`，diagnostics 产出 `hook_dispatch_report`。
- 让 `cell/packages/mod-ai-kernel`、`cell/packages/mod-ai-coding` 与未来更多 mod 通过 `hooks` 字段声明 hook contributions。
- 在 `cell/packages/ai-organ-logic` 增加 hook runtime 代码：在明确 runtime 生命周期边界生产 invocation，执行 dispatcher，并应用 hook effects。
- dispatcher 调用 hook handler 时 SHALL 使用 `depa-processor` 的 `runByFuncStyleAdapter`，沿用项目现有标准组件封装方式。
- 将 thread goal continuation 从 background polling primary path 改造成 actor idle hook contribution，建议 point 为 `actor.idle.before`。
- 针对高频 idle hook 明确多 hook 编排策略，避免多个扩展并发争抢 actor/fiber 状态。
- 扫描并记录本项目已有散点 hooks，给出桥接/迁移边界，避免新 hook runtime 与已有 provider/conversation/snapshot/test hooks 混淆。
- 保留 actor mailbox 作为 goal continuation 的正式投递路径，human input/control 继续优先于 goal continuation。

**非目标:**
- 不把 hook 机制一次性抽成跨所有领域通用的完整 platform hook framework。
- 不复制 Sparrow 的完整 policy runtime 和所有已有 hook points；但 contract 语义必须采用 Sparrow 的 point/mode/action/report 模型。
- 不改变 terminal/TUI 交互语义。
- 不改变 goal tool、`/goal` 命令、goal persistence 的用户可见 contract。
- 不引入新的后台事件总线绕过 actor mailbox。

## 变更内容（What Changes）
- 在 runtime assembly state/result 中加入 hook definitions；definitions 来源是现有模块级 manifest/extension 的新增 `hooks` 字段。
- 在 `ai-organ-logic` 中提供 lifecycle hook dispatcher/runtime implementation。
- 在 `mod-ai-kernel` 中通过 `hooks` 字段声明 thread goal continuation hook，point 建议为 `actor.idle.before`；`mod-ai-coding` 与未来模块沿用同一方式声明 hook。
- 在 `ai-organ-logic` 的 coordinator/background tick/driver settled 边界触发 lifecycle hook invocation。
- 将 `maybeStartThreadGoalContinuation()` 改造为 hook handler 或 hook effect builder，保留现有 idle 条件与 mailbox enqueue 语义。
- 新增 hook diagnostics，以便观察 hook 匹配、跳过、执行、超时、reentrant skip 与 effect application。
- 背景 pump 保留为 watchdog/drain fallback，但不再作为 goal continuation 唯一主触发来源。

## 影响范围（Impact）
- 受影响的功能规范：`cell-runtime-composer-and-mod-profiles`、`ai-runtime-lifecycle-hooks`、`aiagent-thread-goal-runtime`。
- 受影响的代码：
  - `cell/packages/ai-core-contract/src/runtimeComposer.ts`
  - `cell/packages/ai-composer/src/index.ts`
  - `cell/packages/mod-ai-kernel/src/**`
  - `cell/packages/mod-ai-coding/src/**`
  - `cell/packages/ai-organ-logic/src/runtime/**`
  - `cell/packages/ai-organ-logic/src/goals/**`
  - 相关 runtime coordinator、goal continuation 与 focused tests。
