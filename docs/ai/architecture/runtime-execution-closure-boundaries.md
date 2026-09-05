# Runtime 执行闭包边界

本页描述 `realign-runtime-effect-and-composition-boundaries` 的实际代码边界，不宣称全库无依赖环。

## Conversation

- `ai-persistence-logic/ConversationProjection`：原 Prompt/history 物化、tool pairing 等纯规则。
- `ai-persistence-logic/ConversationRecovery`：通过显式 repository port 读取并组合原状态，不选择具体文件实现。
- `ai-support/conversation/local/LocalConversationRuntime`：保留物理恢复、写入与同实现兼容转出口。
- `ai-organ-logic/conversationCapsule/adapterRegistry`：registry 是调用方显式持有的 Map，放在 `ConversationCapsuleRuntime.persistenceAdapters`；导入 support/memory 模块不会注册全局实例。
- `ai-organ-logic/conversation/ConversationDomainRuntimeTypes`：原 runtime 类型，和公共值 facade 分离，避免 internals 经类型导入绕回自身。

## Holon

`ai-organ-contract/organization/HolonTaskPumpJournal` 定义 bytes store/runtime 契约。`ai-organ-logic/organization/HolonTaskPumpJournal` 处理 closed records、identity、重放与 dispatch 顺序；`ai-support/organization/FileHolonTaskPumpJournalStore` 实现原子文件发布、锁和权限。

task routes 的 owner、journal、submission writer、clock、各 Map/coordinator 都由 `HolonTaskRuntimeRoutes` 的 runtime 显式传入。`HolonTaskRuntimeComposition` 复用 VM capability 和原 facet；真正的文件实现选择在 Terminal `AIAgent/LocalHolonTaskRuntimeBootstrap`。Workflow 是同一 service 的适配入口，不能另起文件 owner。

## 配置与权限

模型规则位于 `ai-core-logic/llm/ModelConfigRules`、`ProviderOptions`、`DeepSeekModelCapabilities`；文件路径选择、load/refresh 位于 `ai-support/runtime/LocalModelConfigFiles`。原 organ llm 子路径只转出口同一函数，不维护复制品。

权限 parse/serialize/normalize 位于 `ai-core-logic/permissions/LocalPermissionRules`。解析函数显式接收绝对 cwd，support/facade 每次调用传入当前 cwd，保持原相对路径解释，而不是改为配置文件目录。HOME 展开及文件/目录判断在 `ai-support/permissions/LocalPermissionPaths`。原 store 配置机制不属于此次全局重写范围。

## 多 Actor 恢复证据

多 Actor 共享 session 的 transition head，但各 Actor 的 provider receipt 独立。恢复不能仅凭“当前 Actor receipt 不等于 session 最新 head”判定冲突：最新 head 可能来自其他 Actor 的合法推进。

repository 的 `loadProviderContextTransitionEvidence` 在一个一致读取边界返回 session index、head 及所引用的不可变 generation；文件实现沿用 authority lease/transition lock，内存实现提供同等证据。`ai-persistence-logic/ProviderContextTransitionEvidence` 校验身份、完整内容摘要与 head 所属 Actor 的 durable receipt。Executor 只在证据完整且当前 Actor 的 live/durable receipt 一致时接受其他 Actor 的推进；缺失被引用的 generation、伪造内容、跨 session 或双 authority 仍拒绝。没有新端口的旧 adapter 保持保守恢复行为。

evidence 的 `sessionIndexExists` 来自存储层实际存在性，而不是从 Actor 数量或 head 猜测。已有会话即使没有当前 Actor binding，也必须先匹配 session identity；只有真正未初始化的存储才允许用首次 transition 的逻辑 identity 初始化。损坏文件不能视为文件不存在。

读取证据不能替代提交时的前提校验。file 在 authority lease/transition lock 内、写 immutable generation 和 journal 之前重读并验证 session identity；recovery apply 也验证。memory 在同步提交的任何写入之前执行同一纯规则。这样两个不同 session 同时观察到空存储时，也只能首个 session 成功，拒绝方不留下待恢复日志；同 session 的不同 Actor 仍按原 CAS 合并。

此次未改变持久格式，也未给特定 provider 添加豁免。证据读取需要读取并摘要 head generation；长会话的额外 IO/CPU 成本尚未做性能基准测试，不据此声称性能提升。

## 验证与剩余范围

在仓库根运行：

```sh
bun cell/scripts/runtimeClosureRegression.ts all
bun test cell/scripts/runtimeClosureRegression.test.ts cell/scripts/runtimeClosureBoundaries.test.ts
bun cell/scripts/runtimeClosureBoundaries.ts
```

回归逐文件 fresh 进程执行，只有 scripted provider 和临时 fixtures，不请求真实模型。边界门禁分析 cell TS 源码，包括 type imports、转出口和相对路径；禁止 support 经 lower helper 回到 organ logic，禁止选定规则到 concrete support，拒绝含选定规则的 SCC。manifest 同时检查普通、开发、peer、optional 依赖。

门禁报告仍列出历史 SCC，例如 core-contract 与 organ-contract 的跨域类型契约，以及范围外的 orchestrator、provider plugins 等内部循环。这些没有被隐藏进忽略列表，也不等于此次 support/organ 反向边未移除。

类型检查使用已安装的 TypeScript5.9.3 和 `cell/tsconfig.holon-task-runtime.json --noEmit`；保留本地未发布包解析。`bun.lock` 不纳入 Git；不要用构建生成源码旁 JS 来替代类型检查。
