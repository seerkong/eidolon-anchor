# Design：Conversation 原生 Session Fork 与 Repair

## 上下文

### 历史设计与当前实现的映射

| 历史设计意图 | 当前有效实现 | 本 Track 的修正 |
|---|---|---|
| History Domain 以 generation/head/lineage 表达 committed history | `conversation/history.xnl` 是正文 authority，`history.index.json` 是 bounded head/manifest | fork planner 从 canonical records 解析 fork point，向 child 重放经过重绑定的 XNL records并发布 child head |
| Prompt Domain 独立于 visible history，compaction summary 不能伪装成历史 | `conversation/prompts.xnl` 保存可恢复 PromptGeneration，Prompt index 选择 active prompt | current-head fork复制并重绑定有效 Prompt；message-level fork只接受可证明与目标 history prefix 匹配的 Prompt basis |
| Session Domain 记录 parent/fork lineage 与 active actor/head | contract/reducer已有 lineage slot，但 runtime helper只写 lineage metadata | fork-init 同时创建 child session binding、selection、lineage和三域 head，不允许 lineage-only 子 session |
| rollback/fork runtime surface 被历史 Track 明确延后 | TUI 后来用进程内 `messages/parts` clone 补了表面功能 | surface 改为调用 domain-owned write capability；内存投影只在 durable commit 后 hydrate |
| fork/rewind 是 provider epoch 边界 | 现有 transition Processor要求同一 session 内已有 receipt predecessor | 新增 child-authority initialization 语义；父 receipt只进入 external fork proof，child receipt建立独立 lineage |

### Authority 边界

```text
TUI / CLI / headless
  -> ConversationSessionForkPort
  -> Conversation-owning Actor mailbox (cross-actor / asynchronous entry)
  -> Conversation fork command handler (synchronous command inside the owning Actor)
  -> ForkPointResolver (pure Processor)
  -> ConversationSessionForkPlanner (pure child state plan)
  -> ConversationForkPersistencePort (Effect contract injected by runtime binding)
  -> Local XNL fork-init transaction
  -> child head publish
  -> runtime hydrate / surface projection
```

- Conversation History/Prompt/Session 是唯一 fork 真相。
- Conversation-owning Actor/capsule 是 fork command 的唯一状态变更 owner。surface 与其他 Actor 只能通过既有 mailbox/message 路径请求异步工作；进入 owning Actor 后，resolver/planner/persistence admission 是同一调用栈内的同步 command，不另建消息总线，也不跨 Actor 直接访问状态。
- fork processor 不读取 TUI `messages/parts`、VM snapshot 或 transcript 作为 authority。
- 本地文件系统只是 Effect adapter；业务选择、cutoff、lineage 和 provider 状态分类位于 contract/logic。
- persistence、provider-epoch initialization、clock、id/digest 与 lock/transaction Effect 都必须通过 typed runtime/manifest binding 显式注入；Processor 不读取全局 singleton，不直接实例化本地 adapter。
- surface 只提交命令并消费结果，不写 session 真源。

## 方案概览

### 1. Fork command 与可证明的 fork point

定义 path-neutral command：

```text
ConversationSessionForkCommand
  sourceSessionId
  targetSessionId
  actorKey
  selector = CurrentHead | ThroughCommittedMessage(messageId)
  expectedSourceRevision / expectedSourceHeads
  occurredAt
```

resolver 输出闭合的 `ConversationForkPointProof`，至少绑定：

- source session/actor identity；
- source history head、prompt head、Conversation revision；
- cutoff generation、message record id/count 与 exact frontier digest；
- selected Prompt generation/basis digest；
-完整 tool-call/result 边界证明；
- compaction 边界与证明来源；
- source provider receipt/resource/surface digests的只读 provenance。

`CurrentHead` 直接冻结当前 active History + Prompt authority。`ThroughCommittedMessage` 必须将 surface message id 解析到 canonical committed-message record，而不是按 TUI 数组下标切片。目标边界不能留下 unmatched assistant tool call，不能切开 tool call/result 或 pending-delivery pair。

### 2. 跨 compaction 的 fail-closed 规则

当目标消息位于 active tail 内时，保留该 tail 之前已经成立的 Prompt basis，并把 active generation截断到完整目标边界。

当目标消息位于 sealed predecessor 或更早 compaction 区间时，resolver 必须找到能证明仅覆盖目标 prefix 的历史 Prompt generation，或从仍可读取的 canonical predecessor与对应 transform重建等价 Prompt。以下任一情况返回 typed rejection，且不得创建/发布 child：

- Prompt generation/basis 缺失、歧义或 digest 不匹配；
- 现有 compaction summary包含目标消息之后的内容；
- cutoff 会拆开 tool pair 或 first-delivery ownership；
- source head/revision 在规划与提交之间发生变化；
- fork point依赖被删除、损坏或只存在于非权威 projection。

这是用户已经确认的行为决策，见 `decisions.xnl`。

### 3. Child authority 重绑定

当前 persistence 按 session 目录隔离，History/Prompt records都携带 `sessionId`，因此第一版采用“复制语义、重绑定身份”，不引入跨目录引用：

- 为 child 生成新的 history/prompt generation id 和 record id；
- 保留 source id -> child id 的 fork provenance map/digest；
- child history lineage只引用 child-local generation链；跨 session来源放在 session fork lineage/proof，避免 loader把父 generation误当作本地 predecessor；
- Prompt basis、basis refs、selection、actor binding和资产引用全部按映射重写；
- History/Prompt正文仍分别写入 child的 `conversation/history.xnl` 与 `conversation/prompts.xnl`；bounded indexes只承载head/manifest/current state。

父 session全程只读，child发布后父子拥有独立append lineage。

### 4. Context asset 与 runtime state 分类

Fork planner 对父 session 状态采用闭合 allowlist：

**允许重绑定：**

- Prompt generation实际引用且内容可验证的稳定 session assets；
- 当前 actor/profile/model的非敏感配置选择；
- frozen resource/surface digest与可重新加载的资源引用；
- canonical work/task facts在能重算 child anchor与digest时的等价投影。

**不得复制：**

- provider request admissions、Responses checkpoint、previous response id与continuation baseline；
- provider-native retry/transport state；
- pending delivery optimization与旧 `providerContextFactHead`；
- in-flight LLM/tool stream、fiber continuation、未完成外部副作用；
- surface-only `messages/parts`、status、spinner与dialog状态。

无法分类的资产默认拒绝，不做宽松复制。

### 5. Child provider epoch

跨 session fork 是“新 authority 的 fork 初始化”，不是父 session内的普通 epoch successor：

- child receipt 使用 child session/actor identity；
- child 没有同 session receipt predecessor，`previousReceiptDigest` 不得指向父 receipt；
- parent receipt/source heads作为 `ConversationForkPointProof` provenance参与fork-init digest；
- reason为 `history_rewind_or_fork`，并绑定child baseline heads与fork frontier；
- child request admissions、fact head、checkpoint和continuation从空状态开始；
- 第一次provider request必须由child canonical History/Prompt重新materialize，随后才能append自己的admission。

为此新增一个显式 child-initialization Processor或扩展现有 transition contract的合法initial-fork分支；无论采用哪种代码形态，都复用同一闭合校验、immutable generation、journal、fsync和head-last协议，不能先建空session再补第二次transition。

### 6. 原子 fork-init persistence

本地 adapter 的提交顺序：

1. 获取 target session fork lock，并证明 target 尚未被另一 authority 占用；
2. 重读 source heads/revision并验证 fork-point proof；
3. 写完整 immutable fork generation/stage，fsync file与目录；
4. 写/重放 child `history.xnl`、`prompts.xnl` 与必要asset refs，并在同一stage中写child-owned provider receipt/epoch baseline；
5. 写 bounded child history/prompt/artifact indexes与provider epoch head；
6. 最后以一个CAS publication同时使 `session.index.json`、fork transaction head与provider epoch head可见；若文件系统不能单指令替换多文件，则journal/recovery admission gate必须让未完整发布的child不可hydrate、不可发起provider request；
7. 删除journal并fsync父目录。

实现映射补充：

- Local repository 提供所有 Conversation writers 共用的跨进程 authority lease。`ConversationSessionForkRuntime` 在 source lease 内完成 planning、闭合二次读取与digest比较，并一直持有该lease到target publication完成；因此不存在“二次读取后、target publish前”又被其他writer推进source的TOCTOU窗口。不一致返回 `SOURCE_AUTHORITY_CHANGED`，target不进入publication。
- local support 先把 immutable transaction generation 以 hard-link CAS 发布到单一 `fork-initializations/claim.json`，再发布 journal。claim 跨进程持久存在：相同 transaction 可在崩溃后继续，其他 transaction 在 Session/head 尚未出现时也必须 fail closed；进程内 queue 只用于降低同进程争用，不承担 authority。
- Conversation fork port 显式绑定 owning `sessionId/actorKey/actorId`。surface通过基于`depa-actor`的`ConversationSessionForkActor` typed mailbox发送fork/repair消息并以request id等待completion；mailbox handler内才进入同步command port。非owner命令仍fail closed。

fresh recovery看到：

- 未发布stage：忽略或按journal安全继续；
- 已发布完整head：History、Prompt、Session lineage与child provider receipt/epoch baseline全部一致，幂等完成；
- digest、source proof或target authority冲突：fail closed；
- 永远不能看到 `lineage != null` 但 History/Prompt head为空，或Conversation authority已可hydrate但provider epoch未完成的混合子session。

### 7. Surface 接入

- session list/command palette使用 `CurrentHead`。
- message list使用 `ThroughCommittedMessage(targetMessageID)`。
- 成功结果返回durable child id与fork receipt；surface随后从projection-read port hydrate并导航。
- typed rejection时保留父session、显示原因，不产生或导航到ghost child。
- 删除 `cloneSessionMessagesThrough` 作为fork事实写入路径；它若仍用于纯预览必须无法触达domain truth。
- TUI `session.fork`、headless `runHeadlessConversationFork` 与 CLI `eidolon session-fork` 只投影同一个 `ConversationSessionForkCommand`；CLI/headless 返回原始 domain receipt/rejection，不创建第二套 fork 语义。

### 8. 已损坏 child 的 repair/graft

repair输入必须显式给出parent/child与fork时间或可验证边界，先在副本上dry-run：

1. 证明child缺失fork base但已有自身合法committed tail；
2. 解析parent在fork时刻的准确fork point；
3. 构造child base并把现有child tail重绑定为后继generation；
4. 清除旧provider optimization状态，建立child-owned reasoned successor epoch；
5. 通过与产品fork相同的原子transaction与recovery admission gate写入，不直接散改index，且Conversation与provider epoch必须共同可见；
6. fresh process恢复后比较visible history、runtime prompt与首次provider request；
7. 备份存在且dry-run/实际提交receipt一致后，才允许作用于用户指定现场。

若parent fork时刻无法证明，repair必须停止并报告缺失证据。

## 影响范围与修改点（Impact）

- Contract：fork command/result/proof、typed rejection、persistence port、fork transaction generation。
- Logic：fork-point resolver、child state planner、asset classifier、provider epoch initializer、repair graft planner。
- Support：XNL record rebind、fork-init atomic persistence、fault recovery、dry-run receipt。
- Runtime/Terminal：domain capability装配、TUI入口迁移、成功后hydrate、失败呈现。
- Tests：Conversation unit/property tests、support fault injection、fresh restart E2E、provider request observation、incident-copy repair。

## 决策摘要

- 同一 Track 同时交付 current-head 与 message-level fork。
- 跨 compaction 无法证明准确 Prompt 状态时 fail closed。
- 保持per-session persistence；当前阶段不引入全局共享 generation store。
- child provider epoch独立初始化，父receipt只作fork provenance。
- repair复用产品fork/graft能力，不编写绕开authority的一次性脚本。

## 风险 / 权衡

- **XNL append先于head发布，崩溃后可能留下未引用records**：records必须由immutable transaction id归属；recovery只采纳head可达内容，重复提交按record id幂等。
- **跨compaction历史Prompt不足**：拒绝分叉优先于猜测；后续可另建history-time-travel索引能力。
- **复制资产泄漏transient/provider状态**：闭合allowlist + exact字段验证；未知资产失败。
- **messageID只是surface id**：必须通过canonical messageId/recordId映射，找不到时拒绝，不能回退到末尾。
- **repair错误污染唯一现场**：强制副本、dry-run、digest receipt、备份和fresh recovery验证。
- **多actor session**：首版以请求actor为fork主轴；所有被复制binding必须有可证明head，否则明确拒绝，不制造部分组织状态。

## 兼容性设计

- 既有正确session不迁移。
- 旧TUI fork产生但尚未运行的空child可安全废弃或用repair初始化。
- 已产生child tail的事故session仅在显式parent lineage与fork point可证明时repair。
- 旧`history-generations/*.json`只保留现有upgrade reader语义；新fork输出必须走当前XNL authority。

## 迁移计划

1. 先以复制的父/子session运行只读evidence与dry-run。
2. 实现并验证fork-init/repair transaction后，对事故副本执行实际repair。
3. fresh process恢复副本并捕获第一次provider request，确认父history和child tail均存在。
4. 用户现场另行保留可恢复备份，再用同一receipt执行幂等repair。
5. 若任何proof不成立，停止迁移并保留原现场。

## 待解决问题

- Track的提交模式与校验hook由用户在规划收尾时选择。
