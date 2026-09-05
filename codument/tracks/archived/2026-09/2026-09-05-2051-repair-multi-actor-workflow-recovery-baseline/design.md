# 多 Actor transition head 语义修复

## 现状与定位

AiAgentExecutor.ts 的 persistCurrentProviderContextReceiptBeforeTransport（约 4530 行）从 session.actorBindings[actor.key] 读取 Actor receipt，却直接与 loadProviderContextTransitionHead 返回的整个 Session 最新 head 比较。另一 Actor 的正常 transition 会覆盖这个 session-wide head。当前 persistedDigest 等于 receipt.receiptDigest 时，只要全局 head 既不是自己当前 receipt 也不是自己的 previous，就抛 divergence。

LocalFileConversationPersistenceRepository.ts 的 applyProviderContextTransitionGeneration（约 1470 行）本已用 transitionActorKey 选择唯一 Actor，执行 Actor receipt CAS 并 mergeActorScopedTransitionSnapshots，再写全局 head。这与 executor 把全局最新 head 当成所有 Actor 当前 head 不一致。根因最终以双 Actor 最小红例和原 B1 共同证明，不仅凭推测改判断。

## 映射与 authority

- contract 的 ConversationPersistenceRepository 增加必要的验证过的 transition 读取能力（若需要）；既有 head/generation v1 文件格式不变。
- support 从 head 引用的不可变 generation 读取证据，验证路径 identity、schema、内容 digest、head next digest、一致且唯一的 Actor identity。缺失被引用 generation 与完全不存在 head 必须区别处理，不能都降为 null。
- logic 消费验证后的事实。只在当前 Actor 的 durable receipt 与 live receipt 一致，且最新 head 确有另一个 Actor 的合法 generation 证据时，允许正常交错；同 Actor 分歧仍拒绝。不能只看到别的 actorBindings digest 相同就跳过，因为那没有证明 head 的真实 generation。
- 若读取 API 不存在，保留原有保守行为，不静默假设安全。保存前驱 CAS、双 authority 和损坏保护，不引入第二份可变 Actor head authority，也不扫描整个历史重建全局状态。

### Fresh 预审纠偏

仅验证历史 generation 合法还不足以证明它是当前 head。repository 的新证据读操作必须在同一个一致读取闭包中取得 current session、head、引用的 generation：file 使用现有 authority lease 和 transition lock，先完成现有 journal recovery；memory 同步取得同一状态并保留已提交的不可变 generation。校验 head owner 的当前 durable receipt 等于 head.next、generation/session/receipt 的 sessionId 与 actorKey/actorId 一致且唯一。executor 使用这个同一快照的当前 Actor binding，不再把操作外独立 loadSessionIndex 结果与其拼接。

上述 head owner durable receipt=head.next 等式只用于“其他 Actor 正常交错放行”分支，不是证据 port 无条件拒绝的条件。port 验证原始 head/generation identity 后返回一致快照事实；logic 再区分同 Actor 已提交、同 Actor predecessor-head repair、完全 missing-head repair、其他 Actor 正常交错和真正分歧。既有同 Actor current/live receipt 已推进而 head 仍指 previous 的合法修复必须保留，不能被新 port 提前拒绝。

file 和已有 memory adapter 都实现同一证据 port；旧第三方 adapter 未提供 port 时仅保留原保守逻辑。新增反例必须覆盖合法但陈旧的另一 Actor generation、跨 Session generation、读取间 Actor 推进，以及缺失/篡改引用。不得把 file-only 通过当作完整修复。读取后的并发写依旧由既有 Actor CAS 和持久 authority lease 约束，不新增可变 head authority。

## 验证

先新增 A→B→A 的最小失败测试，再覆盖 fresh repository/恢复、合法 predecessor head repair、完全 missing head repair、同 Actor divergence、缺失/篡改 generation、head digest 与 generation 不一致。原 SubFlow selected/authored Worker 用例不改变断言或放宽超时。全量矩阵 fresh 独立进程逐文件运行，避免 mock 污染。所有 noEmit 指向已安装 TS5.9.3。

## 边界

### 实施红例纠偏：空 file repository 初始化

最小空 repository case 显示：memory 以 transition.sessionId 创建首次默认快照；file 以 sessionDir 创建默认快照，merge 保留该目录identity，即使首个receipt已经使用逻辑sessionId。原B1在正证据校验接入后也转为session identity冲突。允许在确定不存在session.json的首次apply中使用transition的逻辑sessionId初始化默认session/history/prompt/artifact；已存在authority文件一律不重命名，不据此放宽跨session校验。用file/memory首次初始化等价红→绿证明。

一致读取不得持有authority lease后等待同一instance中正在该lease外排队的memoized recovery Promise，否则并发loadEvidence/recover可自锁。采用已持锁的内部恢复操作或等价显式顺序，仍在同一authority保护下处理journal并读快照，测试覆盖同instance读/恢复/提交交错不挂。

### 总矩阵纠偏：成熟 Workflow fixture 的稳定身份

总矩阵round1暴露workflow_complete_agent_ctrl_data_e2e在by-id续跑失败。实测head/generation/receipt使用complete-agent-runtime-session，currentSession顶层/内层却为临时目录绝对路径；初始VM没有sessionId，而其后save/recover固定传入另一个ID，旧flush查不到相应raw并跳过、恢复rekey外层但保留内层ID。新证据检查正确拒绝此跨identity现场。

将此fixture初始metadata显式设置为与其save/recover一致的稳定sessionId，保持原99业务断言、provider调用计数、Ctrl/Data图和by-name/by-id续跑流程、超时不变。另加自洽但不同Session证据拒绝且持久authority不变的反例。此为测试初始化纠偏，不是允许重命名已有session，不扩张修改全局snapshot迁移API。round1失败、identity诊断和修订均保留记录。

不授权真实 provider 费用、用户 session 修复、build/local:install 或 commit。行为纠偏独立于 G3/G4/G5 的等价重构记录。实现如发现并非 Actor scope 根因，先据最小证据修订设计，不套用预定修复。

### Phase fresh 纠偏：首次出现的 Actor 也受 session identity 约束

47 文件矩阵通过后，两个独立 fresh reviewer 均复现：已有 session-one/A authority 的目录被 session-two/新 Actor C 使用时，因当前 Actor 尚无 durable binding，executor 跳过 session identity 检查并写入混合身份。原跨 session 负例只覆盖已存在 Actor，不能证明此分支安全。

session identity 是持久 session 的约束，不以当前 Actor 是否已有 receipt 为前提。新增 file/memory 反例必须在第一次 transport 前拒绝此情况，且全部持久 authority 不变；真正未初始化 repository 的首次逻辑 identity 初始化仍保留。修复后重新验证任务并跑完整矩阵、fresh GapLoop，不沿用修复前的绿色回执收口。

一致 evidence 还需携带物理 authority 是否存在的 `sessionIndexExists` 事实：file 从真实读取的 ENOENT、memory 从已存 sessionIndex 得到。不能从 head 或 actorBindings 非空推断存在性，否则会漏掉已持久化但尚无 Actor 的空 Session。该事实不写入持久 schema，只用于区分首次初始化与已有 authority 的身份约束。

### 第二轮 fresh 纠偏：发布临界区内重验 identity

前置 evidence 只能证明观察时刻。两个不同 session 的新 Actor 可以同时观察到 absent，随后依次进入原 Actor CAS 并都被接受，产生跨 Session binding。memory 与 file 的真实并发 barrier 实验均已复现。

在实际持久发布的临界区内，必须重新检查已存在 Session identity 与待提交 generation identity 一致；检查要在写入 immutable generation/journal 等恢复材料之前，避免被拒绝请求留下可反复污染 recovery 的日志。memory 同步提交区执行同等检查；保留同 Session 的并发新 Actor、原 Actor CAS、合法 journal 恢复和初次初始化。新增异 Session 竞争拒绝/无额外authority污染、同 Session 竞争成功的双 adapter 用例。

提交校验接入后，原 epoch suite 的 stale-per-actor merge 与 durable fault recovery 两个 fixture 暴露自身双 ID：从空 repository 加载默认快照后，仅改 `sessionIndex.session.sessionId`，顶层和 history/prompt/artifact 仍为临时路径。统一这些 fixture 的全套 snapshot identity，原 78 条断言和全部 fault points 不变，另加 8 条身份一致断言。这是测试初始化纠偏，不允许生产对已有 Session 偷换 ID。
