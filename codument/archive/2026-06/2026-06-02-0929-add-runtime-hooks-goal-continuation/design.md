# Design

## 上下文
本项目的吸引子要求 runtime 能力通过 profile/manifest 装配，AI 领域语义收口在 AI domain runtime 边界，并且 actor 相关动作通过 mailbox 通信。当前 goal continuation 已经通过 mailbox 投递 `heartbeat`，但触发点是 `tickAiAgentRuntimeBackground()` 中的固定轮询逻辑，缺少可组合 lifecycle hook 层。

Sparrow 的 hook 机制提供了可参考结构：hook definitions 存在 extension registry 中；runtime 在 hook point 上构造 invocation context；dispatcher 按 matcher 和 priority 过滤排序；每个 hook 有 timeout、fail-open、reentrancy guard 和 diagnostics report。关键是：hook point 是 `domain.action.phase` 字符串，不是枚举式事件类型；hook mode 是 `observe/transform/decision/around`；result action 是 `continue/replace/deny/ask/retry/stop`；diagnostics event type 是 `hook_dispatch_report`。本项目应采用这个 contract 形状，再按本项目 package 边界落地。

## 方案概览
1. 新增 hook contract 与 assembly extension
   - 在 AI domain assembly contract 中定义 `RuntimeHookDefinition`、`RuntimeHookMatcher`、`RuntimeHookInvocationContext`、`RuntimeHookResult`、`RuntimeHookDispatchReport`、`RuntimeHookDispatchStepReport`。
   - `point` 使用可扩展字符串，命名遵循 `domain.action.phase`，例如 `actor.idle.before`、`tool.execute.after`、`llm.request.build.after`。
   - `mode` 使用 `observe`、`transform`、`decision`、`around`；`action` 使用 `continue`、`replace`、`deny`、`ask`、`retry`、`stop`。
   - `matcher` 至少包含 actor、tool、provider、shell、command、extension、path、risk、tags 等维度，保持 actor-aware 且 shell/provider 无关。
   - 在现有 module extension/manifest contract 中新增 `hooks` 字段；`mod-ai-kernel`、`mod-ai-coding` 与未来 mod 都只通过该字段声明 hook contributions。
   - 在 `DomainRuntimeAssemblyState/Result` 中加入 `hooks` 或 `hookDefinitions`，用于承载已装配 hook definitions。
   - assembly 层只承载/归并 descriptors，不拥有 dispatcher，不新增平行 hook 注册链路。

2. `ai-organ-logic` 提供 hook producer 与 dispatcher
   - Runtime coordinator 在明确边界生产 lifecycle event：interactive turn finished、background settled、mailbox drained 后检测 idle、session resumed 后首次 idle。
   - Hook invocation 在 coordinator 的串行 `enqueue()` 内同步完成，避免与 runtime mutation 并发。
   - Dispatcher 位于 `ai-organ-logic`，负责 hook 排序、matcher、reentrancy guard、per-cycle budget、timeout、diagnostics result。
   - Dispatcher 调用 hook handler 时必须使用 `depa-processor` 的 `runByFuncStyleAdapter`。hook handler 以标准组件方式表达 outer input、derived、inner runtime/input/config、core logic 与 outer output。
   - Hook result 不直接改 VM。producer 统一应用 effect，例如 `mailbox_enqueue`、`resume_fiber`、`emit_diagnostic`、`request_snapshot`。

3. 扩展模块提供 hook contributions
   - `mod-ai-kernel` 在模块级 manifest/extension 的 `hooks` 字段中声明 AI kernel baseline hooks。
   - goal continuation hook 作为 `mod-ai-kernel` 的 hook contribution 注册到 `actor.idle.before`，但 dispatch 与 effect application 仍由 `ai-organ-logic` 执行。
   - `mod-ai-coding` 与未来更多 mod 以同一 `hooks` 字段声明自己的 hook，不允许另建全局 hook registry 或直接 import runtime dispatcher 注册。
   - `mod-ai-kernel` 的代码组织 SHALL 参考 Sparrow extension package 的扩展类型分层方式：`tooling/`、`bootstrap/`、`catalog/`、`support/`、`slash/`、`hooks/`、`prompt/` 分别承载对应扩展项；根 `index.ts` 只负责 assembly apply 编排和对外 re-export。
   - `mod-ai-coding` 的代码组织 SHALL 使用同一规则：`agent/` 承载内置 agent 定义与 agent config 装配，`prompt/` 承载提示词片段与提示词 section 装配，`hooks/` 承载 coding overlay hook descriptors；根 `index.ts` 只负责 assembly apply 编排和对外 re-export。
   - Prompt 文本 SHALL 从代码中分离，放入 `prompt/` 下的独立文本片段，并通过 Bun text import 装配，避免在 TypeScript 代码里内嵌长提示词。

4. 高频 idle hook 编排
   - idle hook point 不使用特殊 `runtime_idle` 事件；采用 `actor.idle.before`。必要时后续可补 `actor.idle.after` 或 `actor.idle.error`。
   - `actor.idle.before` hooks 默认顺序执行，排序键为 `priority desc`、`extensionId`、`name`。
   - 每个 hook 执行前基于最新 VM/driver state 重新构造 idle snapshot；如果已经不 idle，则停止本轮 idle hook dispatch。
   - Hook 结果 action 使用 Sparrow 对齐的 `continue/replace/deny/ask/retry/stop`。对 idle 场景，`continue` 表示不抢占当前 lifecycle，后续 hook MAY 继续执行；`stop`、`deny`、`ask` 表示当前 hook 明确接管或阻断当前 lifecycle，本轮后续 hook SHALL NOT 执行。
   - Producer SHALL NOT 因为某个 hook 返回了 effects 就默认停止后续 hook。只有两类情况会停止后续 hook：hook 明确返回 `stop/deny/ask`，或该 hook 的 effects 被 producer 应用后导致下一次 idle 重检发现 actor/fiber 已不再 idle。
   - 对 `actor.idle.before` 这类高频 lifecycle，producer SHOULD 在每个 matched hook 成功后立即应用该 hook effects，然后下一个 hook 前重检 idle 状态；这避免后续 hook 基于过期 idle snapshot 继续投递工作。
   - Goal continuation hook 在成功投递 continuation heartbeat 时 SHOULD 返回 `stop`，表示它已经 claim 当前 idle cycle。纯观测或诊断 hook SHOULD 返回 `continue`，除非它需要明确阻断后续 hook。
   - 每轮 idle hook 有总预算和最大 hook 数，单 hook 有 timeout。超时/失败按 `failOpen` 决定继续或停止，并发出 diagnostics。
   - Hook handler 不允许直接启动 LLM/provider/tool 调用，只能返回 effect，由 producer 串行应用。

5. Goal continuation 改造
   - 保留现有 goal idle 条件：没有 interactive turn、goal active、没有 continuation in-flight、control actor 存在、没有 pending `humanInput`/`heartbeat`/`memberChatInbox`/`control`、main fiber suspended/ready。
   - 将上述判断移入 `actor.idle.before` hook handler。
   - Hook effect 使用现有 mailbox enqueue 语义，向主 fiber 投递 `heartbeat`，payload 为 `{ heartbeatKind: "runtime_internal_context", source: "goal", text }`。
   - `humanInput` 继续比 `heartbeat` 优先，用户在模型运行期间输入的消息应进入 mailbox 队列，并能在下一次 idle 判断前阻止 goal continuation。
   - Background pump 只作为 watchdog：当没有前台 turn 触发 idle hook 时，周期性尝试触发 idle lifecycle event；它不再直接调用 goal continuation 逻辑。

## 影响范围与修改点（Impact）
- `ai-core-contract/runtimeComposer.ts`：新增 hook descriptor/result/effect contract，并扩展 assembly state/result。
- `ai-composer/src/index.ts`：初始化、reduce、finalize hook definitions。注意它不拥有 dispatcher。
- `mod-ai-kernel/src/**`：在模块级 manifest/extension 的 `hooks` 字段声明 kernel baseline hooks。
- `mod-ai-coding/src/**`：必要时以同一 `hooks` 字段声明 coding overlay hooks。
- `ai-organ-logic/src/runtime/**`：新增 hook producer 与 dispatcher runtime ops，并在 coordinator/background settled 边界调用。
- `ai-organ-logic/src/goals/**`：goal continuation 改造成 hook contribution/handler。
- focused tests：覆盖 hooks 字段 assembly、dispatcher ordering、`runByFuncStyleAdapter` handler invocation、idle high-frequency orchestration、goal hook continuation、human input preemption。
- 现有散点 hooks：
  - `AiAgentLoopHooks` 保持 test-only，后续可用正式 hook point 替代。
  - `ConversationDomainPersistHooks` 保持 persistence side-effect port，不并入本轮 hook dispatcher。
  - provider scene capture hook 保持 observability-only，后续可桥接到 `llm.request.*` hook points。
  - depa-actor recovery/scheduler hooks 属于 vendor foundation，不并入 AI hook registry。

## 决策摘要
- 详见 `decisions.md`。
- 当前建议：idle hook 使用同步、串行、确定性 dispatch；contract 本轮先放 AI domain assembly；dispatcher 归属 `ai-organ-logic`；mod 通过现有 manifest/extension `hooks` 字段贡献 hook；hook point 采用 Sparrow 风格字符串；background pump 保留为 watchdog，不作为 goal continuation 主路径。

## 风险 / 权衡
- 风险：hook 机制过度平台化，导致本轮范围膨胀。
  - 缓解：只做 lifecycle hook 子集，先放 AI domain kernel，未来有第二个领域复用证据后再下沉 platform。
- 风险：多个 idle hook 重复 enqueue/resume。
  - 缓解：每个 hook 前重检 idle snapshot，effect 应用后设置 barrier；`stop` action 可停止本轮 dispatch。
- 风险：hook 执行阻塞 foreground。
  - 缓解：idle hook 必须轻量，同步决策，异步重活通过 mailbox/effect 延后；设置 per-hook timeout 和 per-cycle budget；handler 调用走 `runByFuncStyleAdapter` 以保持标准化边界。
- 风险：goal continuation 从轮询迁移后丢触发。
  - 缓解：interactive turn finished/session resumed/background watchdog 都生产 idle lifecycle event，并用 focused tests 覆盖。

## 兼容性设计
- 用户可见 goal contract 不改变：`/goal`、goal tools、goal persistence、goal status surface 保持现有语义。
- 内部实现允许移除直接 background tick goal call，但保留兼容行为的 watchdog 触发。
- 不要求旧 session 迁移 hook 状态；hook definitions 来自当前 runtime assembly 中的 module `hooks` descriptors。

## 迁移计划
1. 先扩展 contract 与 runtime assembly，使 module manifest/extension 支持 `hooks` 字段。
2. 在 `ai-organ-logic` 添加 dispatcher、producer 与 diagnostics，dispatcher handler invocation 使用 `runByFuncStyleAdapter`，diagnostics 输出 `hook_dispatch_report`。
3. 让 `mod-ai-kernel` 通过 `hooks` 字段声明 `actor.idle.before` goal continuation hook，先只观察不改变 goal 行为。
4. 将 goal continuation 切到 hook effect，并移除 background tick 直接调用。
5. 增加回归测试，验证 idle 后自动续接、pending human input 阻止续接、多个 idle hooks 按顺序执行。

## 待解决问题
- 是否在本轮实现 `around` hook mode 的完整 next-call 包裹：当前建议 contract 先定义，完整 around operation 可后续分阶段实现。
- diagnostics 最终投影到现有 rx stream 的哪个 sink：事件类型应固定为 `hook_dispatch_report`，sink 归属实施时对齐当前 rx data plane。
