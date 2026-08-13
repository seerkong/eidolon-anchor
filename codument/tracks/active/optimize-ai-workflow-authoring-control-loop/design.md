# 设计：AI Workflow 编辑控制环与发布事实契约

## 1. Authority 分层

本 track 保持三个不同层次，不互相替代：

1. **Conversation / Context authority**：Eidolon 通用 Conversation Domain、ContextCompressor 和 provider materialization 拥有 history 与上下文预算。
2. **Workflow authoring authority**：authoring session store 拥有 workspace revision、proof identity、publication receipt 和完整 diagnostics。
3. **Workflow tool read model**：list/summary 只投影模型下一步决策所需的 brief；它不是压缩器，也不成为第二事实源。

禁止在 AI Workflow 包中新增 conversation history、token compaction、tool-result spill 或 provider-message cache。

## 2. Authoring session revision model

将当前 `status: open | published` 与 `currentRevision` 扩展为可恢复、可迁移的版本化 metadata：

- `baseRevision`：当前 `/base` 的 content digest，作为 diff baseline。
- `workingRevision`：当前 `/work` 的 content digest。
- `publishedRevision?`：最近一次成功发布并 canonical readback 的 revision。
- `dirty`：`workingRevision !== publishedRevision`；从 revision 派生，不由调用方写入。
- `proofSet?`：绑定 exact `workingRevision` 的 diff、validation、build 和 acceptance receipt identities。
- append-only publication receipt journal：独立于 session summary metadata，每条不可变地记录 receipt id、revision、artifact digest、target、definition identity、proof identities、publishedAt。
- `latestPublicationReceiptId?`：session metadata 中唯一的 latest projection；重复发布不得覆盖或删除 journal 中的旧 receipt。
- `lifecycle`：区分 `editing / ready_for_publication / published_clean / published_dirty` 的派生 projection，避免 mutation 后仍伪装成 clean published。

旧 session metadata 通过 deterministic schema migration/normalization 读取；不从自然语言或目录名猜测 publication 状态。

发布成功后将已 readback 的 published bundle 作为新 `/base` baseline，更新 `baseRevision`；后续 diff 只显示相对最近发布版本的真实修改。若 rebase 中断，恢复逻辑依据 publication audit/receipt 完成或重试，不制造第二 publication。

## 3. 原子多文件 patch

新增一个结构化 component command，输入：

- `sessionId`
- `expectedWorkingRevision`
- `operations[]`，每项为显式 `add | update | delete`、logical path 和 content（delete 无 content）

执行顺序固定为 containment/schema 校验 → duplicate/conflict 校验 → expected revision CAS → staging tree → candidate digest → atomic replace → 一次 metadata/proof invalidation。任何预检或 commit 失败都不暴露部分 bundle。

模型决定哪些文件和内容要改；代码不得根据用户原话、文件内容关键词或业务名推导 patch。

## 4. Proof pipeline

将发布前确定性步骤组合为 exact-revision pipeline：

1. `diffReceipt`：相对 `baseRevision` 的真实变更与 digest。
2. `validationReceipt`：canonical depa-flows loader/binding diagnostics。
3. `staticProjectionReceipt`：执行既有 canonical static dry-run，绑定 exact revision/digest 并保留 `effectDispatched: false`；它是必需发布 proof，但不是 runtime acceptance。
4. `buildReceipt`：解析 bundle、logical refs、code exports 和 assembly/link digest。
5. `acceptanceDispositionReceipt`：记录 `required | not_required`、policy source 和 exact revision。policy source 只能来自 canonical profile/manifest 或显式结构化 definition policy，禁止从用户文本、代码正文、文件名或 workflow 名称推断。
6. 当 disposition 为 `required` 时，追加 `candidateAcceptanceReceipt`：只在 canonical depa-flows runtime 中注入隔离 Eidolon effect test double/fixture，记录 success/degraded/failed evidence。

静态 `effectDispatched: false` projection 可以作为 lint/plan evidence，但不得命名为 effectful runtime acceptance。发布前 candidate acceptance **不得**访问真实网络、调用真实外部服务或产生真实业务副作用；真实 public-source acceptance 只能在发布后获得独立 execution authorization 后执行，并形成与 publication proof 分离的 execution receipt。

`preparePublication` 可在一个 deterministic tool call 内顺序产生上述 receipts；它不做语义推断。任一 mutation 使整组 current proof 失效。publish gate 必须检查同一 revision/digest 的 diff、validation、static projection、build、acceptance disposition receipts 与显式 publication authorization：`required` 还必须有通过的隔离 candidate receipt，`not_required` 必须有 canonical/explicit policy source。publication authorization 永远不能代替 execution authorization。

## 5. Typed authoring result

`WorkflowAuthor` 不再把长自由文本或模型自报结果当作完成 authority。模型只能请求结构化 terminal transition；component/session authority 读取持久化 session、exact revision、proof identities 和 publication journal，校验后生成 `WorkflowAuthoringReceipt`，至少包含：

- `authoringSessionId`
- `stage / outcome`
- `workingRevision / publishedRevision / dirty`
- `changedPaths` 和 proof/publication receipt identities
- `nextAction` 与有界 diagnostics summary

这里的 `authoringSessionId` 是 workflow workspace session，不是未来要支持复用的 Eidolon agent session id。父 actor可以把 component 生成的 receipt 投影成人类可读答案，但不得再次 list/get full metadata 或重跑 proof；伪造、stale 或仅由模型声明的 receipt 必须被拒绝，仅 schema/identity/revision 校验失败时进入诊断路径。

## 6. Brief/summary read model

- `WorkflowListAuthoringSessions` 按 `updatedAt desc, sessionId asc` 稳定排序并分页；默认 `limit=20`、硬上限 `100`，返回 opaque cursor、total 和 truncated。每项 brief 只含 session id、form、lifecycle、working/published revision identity、dirty、proof presence、updatedAt。
- `WorkflowGetAuthoringSummary` 返回单 session summary：brief + changed file counts + diagnostics counts + 至多 20 个 code/receipt references + truncated/count 元数据，不携带完整 binding、source、static projection、publication history 或逐节点 diagnostics body。
- `WorkflowWorkspace(operation=describe)` 或显式 detail operation 继续返回完整 authoritative metadata。

read model 由纯 projector 从完整 session 派生，不能独立持久化或反向写 session。这样只影响 AI Workflow tool contract，不改变其他 Eidolon 工具。

## 7. 通用 delegate context policy

`shouldCompressActorHistory` 不再用 `primary/member` 身份硬编码 eligibility。actor contract 增加通用 context policy（例如 `historyCompaction: auto | disabled`）：

- 多轮 primary/member/delegate/detached actor 默认 `auto`。
- 明确的单工具、短生命周期 actor 可由 actor config 设为 `disabled`。
- compaction 仍复用 ContextCompressor、Conversation materialization、pending-first-delivery protection 和通用 resource facts。
- 实现不得检查 `agentType === workflow`、tool name 或用户文本。

本 track 只建立/应用通用 policy，不提供自定义 compaction prompt。该扩展留给后续 track。

## 8. 控制环轮次优化

语义选择继续由模型负责，但协议改成：

- stage selection 输出显式 transition；host 依据结构化 stage id 激活 tool policy/context，不额外要求一轮解释性自然语言。
- coding 先读取 brief/tree 并锁定目标，再一次提交 coherent atomic patch；避免逐文件写入。
- testing 使用 deterministic prepare-publication pipeline；模型只在 diagnostics 存在时进入有界修复。
- releasing 消费 typed proof receipt；不重复 summary/read/validate。
- prompt 要求 reasoning 不复述完整源文件，源码只出现在 patch arguments 中。

host 仍不得根据动作动词或业务词选择 stage；它只验证模型给出的显式 stage transition 是否满足确定性前置事实。

## 9. Observability 与 retention

常规 session diagnostics 保存：provider call/turn id、first-token/generation/tool duration、token counts、tool receipt identity、workspace transition、proof/publication timing。逐 token/delta 的 think/reasoning body 只在显式 debug retention 策略下保存，并有容量/期限上限；关闭 debug 时不把 raw reasoning 写入长期 session artifact。

性能验收同时使用 scripted deterministic harness 和真实 provider 回放。scripted harness 锁定轮次/transition；真实 provider 报告耗时分布，不用一次偶然网络值代替结构性证据。

## 10. 兼容与迁移

- session store 的 full `describe/list` 继续服务 component/Workspace detail reads；tool adapter 改用 projection。
- 如现有 AI Workflow 工具调用方依赖 full summary，提供显式 `detail` operation 或一次性版本迁移，不把 full payload 留在名为 summary 的默认路径。
- 旧 published session 在 migration 后保留现有 target/revision 证据；无法证明 publication receipt 的字段标记为 legacy/unknown，禁止伪造 digest。
- 原有静态 dry-run 语义必须保留，并升级为 exact-revision/digest-bound `staticProjectionReceipt`；新的 publish gate 必须消费它，同时明确它不构成 effectful acceptance。

## 11. 风险与控制

- 原子 patch 扩大单次 mutation 范围：用 expected revision、staging tree、all-or-nothing tests 和 audit receipt 控制。
- generic delegate compaction 会影响非-workflow actor：通过 primary/member/delegate/detached matrix 和 first-delivery regression 验证，不做 workflow 特判。
- candidate acceptance 严禁真实外部副作用：只允许注入隔离 effect test double/fixture；真实 effect 只能在发布后通过独立 execution authorization 进入正式 run，并形成独立 execution receipt。
- read model 兼容风险：限定在 workflow tool adapters，并保留显式 detail authority。
