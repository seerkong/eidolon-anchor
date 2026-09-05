# Design：执行闭包的职责与依赖归位

## 1. 范围和原则
基线 f28c0d6。用户要求“每次整理一个真实执行闭包，不全库重写或改名”。本 Mission 与任务修复/资源演进 Mission 独立。遵循 `codument/attractors/project.md` 中 runtime 显式、contract/logic 分离、既有 vendor 原语和可验证性；depa-expert 负责在设计/迁移/replan 时核对角色、owner 与依赖。

bun.lock 永不加入版本管理，不更改忽略规则；本地引用未发布包是正式开发需求。可以在本地验证回执记录源码版本/内容身份和临时解析结果，不能强制整个项目改 registry 依赖。规划采用 auto routine decisions；实现提交 manual。标准四 actor 协议仅引用 `codument/std/spec/mission-xnl-spec.md`。

## 2. 源码到目标职责的映射
下列路径相对 host 根，执行前确认具体导出与所有真实消费者。

| 原位置 | 当前职责/问题 | 目标归属与不变量 |
|---|---|---|
| cell/packages/ai-organ-logic/src/conversationCapsule/internals/domainRuntime.ts:44 | 直接导入 ai-support 的 loader、Prompt/history materializer | domain core 只消费 contract ports 和 pure logic；装配方注入 IO |
| cell/packages/ai-support/src/conversation/local/LocalConversationRuntime.ts:541/779/892 | repository 加载、pure Prompt 与 compaction 写入混装 | pure 规则迁至既有 ai-organ-logic；加载/写入由明确 contract support 承担，算法语义保留 |
| cell/packages/ai-support/src/conversation/local/LocalConversationPersistenceAdapter.ts:2/20 | support 依赖 logic 并加载时注册 | support 导出实现/factory；现有宿主显式连接 registry/lifecycle，不靠 import 顺序 |
| cell/packages/ai-organ-logic/src/organization/HolonTaskPumpJournal.ts:4/384/417 | file store IO 与 journal 接口/逻辑混装 | contract/纯幂等规则与 concrete file IO 分离；后者归既有 ai-support，不改变 intent/result identity |
| cell/packages/ai-support/src/organization/LocalHolonTaskRuntimeBootstrap.ts:4/39 | support 同时选择 rules/adapter 并组装 | 移到已存在显式宿主或经证据确认的真实 composition closure，support 只实现 effect contract |
| cell/packages/ai-support/src/organization/LocalHolonTaskRuntimeSupport.ts:22/156/169 | 导入 logic concrete store，构造 File TaskSpace/journal | 保留真实 port 实现；concrete store 由组合入口选择，保持单 TaskSpace owner |
| cell/packages/ai-organ-logic/package.json:24 与 ai-support/package.json:23 | manifest 及源码双向依赖 | 迁移全部属于选定闭包的边后验证实际图；不能只删 manifest 再用相对路径跨 internals |
| terminal/packages/organ/src/AIAgent/TerminalRuntime.ts:1147 | 默认产品启动装配独立 Holon 与 generic actor | 作为真实调用者验收，不仅通过 isolated mock；不得用宿主位置隐藏领域规则 |

目标 package 默认保留现有 `@cell/ai-organ-contract`、`@cell/ai-organ-logic`、`@cell/ai-support` 和 Terminal 宿主，不凭空预建新包。如有多个真实消费者需要新 capsule，必须先列 selected contract/logic/support/adapter closure、公开生命周期与合法 -capsule 名称，再以 evidence replan；adapter 仍归执行封装的一方。发布策略独立，本 Mission 不自动发 npm。

## 3. Owner 与依赖方向
- Conversation repository owns generations/heads/receipt，live domain runtime 通过声明恢复入口更新；纯 materializer 仅生成值。
- TaskSpace owns task/claim/lease/result；journal 记录 accepted-effect intent/result；generic actor runtime owns session/history。
- support 只按 contract 实现物理 IO/事务/恢复，不自行决定领域路由；logic 经 runtime ports 调用 effect。
- composition 拥有“选哪些实现、何时 open/close”的生命周期，不拥有第二份 task/history truth。
- projection/cache 可维护自己的读模型，不得借迁移直接回写 authority。

预期依赖：宿主/真实组合闭包 → 公开 logic + support + adapter → contract。跨 actor 异步边界继续 message；同步注入 port 不强制 actor 化。先把可分离 IO/组合归位；仍有本质协作环时再在证据支持下用既有 actor/mailbox 解开，禁止用 global、WeakMap、延迟 import 隐藏。

## 4. 迁移与控制论循环
G1 识别所有选定闭包入口与当前剩余边；G2 真实 Track 固定可执行基线；G3 Conversation；G4 Holon；G5 清除剩余实际反向边并维护依赖检查；G6 总目标验收。一次只提交一个闭包的语义等价变换给验证，不把多个失败源混在一起。

```text
@delimiter: --
@node: #
@marker: ?
-- #loop ?closures until="选定闭包全部归位且回归通过"
---- #step ?baseline
确认所有消费者、当前 owner 和可运行行为基线，协调在途变更。
---- /?baseline
---- #step ?relocate
真实 Track 迁移纯规则或具体 IO/装配，保留调用语义与持久格式。
---- /?relocate
---- #step ?check
比较 wire/receipt/恢复和 import 图；有偏差先找证据、纠偏或 replan，不开启下一闭包。
---- /?check
-- /?closures
```

每个实施 Track 设计配置阶段 GapLoop、verify_round 与 manual commit；Mission 每 operation reconcile。初始仅规划的限制已由后续用户 impl-mission 授权替代；现在按 DAG 创建并绑定实际 Track、实现并测试，不触 build/install/commit/publish。

## 5. 等价验证矩阵
| 闭包 | 必须保持的行为 | 验证方式 |
|---|---|---|
| Prompt/history | system/common/coding 指令、workspace AGENTS、原 history 切分/splice、tool pairs、handoff/compaction、provider conversion | 原 raw state 的 wire digest/order golden + 支持模型协议转换测试；同配方 prefix 不漂移 |
| Conversation persistence | head/generation/receipt、fork/rewind/重启可见边界 | 真实文件 fixtures + fresh client/OS 隔离样例；不用 UI 正确代替模型上下文正确 |
| Holon TaskSpace/journal | accepted effect identity、claim/lease/result、none/stream/final、shared/fresh continuity | port contract suite、真实文件执行、独立 Holon 与 Ctrl/Data 回归 |
| composition | 所有实际入口同样 open/close、无加载顺序依赖 | 冷进程加载、替代 in-memory port、主产品默认入口 smoke |
| dependency | 目标边删除而不是隐藏 | 源码 import + manifest + exports/re-export 图联合检查，无相对路径逃逸或白名单绕过 |
| development | 本地未发布包能接入，不污染源码树 | 当前本地依赖解析运行专项；noEmit typecheck 前后文件状态核对；bun.lock 未跟踪 |

纯重构不能故意改变 Prompt 而解释成“更好的提示词”；资源版本升级属于兄弟 Mission，在新版本语义下另外比较。若重构暴露当前已有 bug，先记录并判断是否阻碍本闭包，必要时分独立修复 Track，不能混入所谓等价迁移。

## 6. 与任务自主 Mission 的交接
`evolve-holon-task-repair-and-resource-autonomy` 增加能力，本 Mission 归位依赖。二者没有 ParentMission/整体完成依赖，不制造彼此等待。交接按真实 Track 与公开 port：
- 本 Mission G2 基线可被对方引用；对方 G2 跨进程测试可成为本 Mission 迁移后回归，但不存在等待对方全部完成的门禁。
- resource registry/ContextPipeline、TerminalRuntime、journal/bootstrap、Conversation materializer 的同文件写入串行；另一 Mission 等待交接时可以执行不冲突节点。
- 以 .tmp/chat.jsonl 协商在途编辑，稳定边界/新位置/旧 API 兼容策略写入各 Track design；不要靠临时聊天长期承载 truth。
- public port 签名或导出位置改变，写变更清单并同步对应测试/消费者；不留下两份可写旧实现做永久兼容。
- 发现跨外部项目问题先定位 owner，再提 replan；本 Mission 初始只含 host，不擅自给外部包发布改版。

## 7. 重规划与完成门槛
若残余环穿过未列举模块、纯规则包含隐藏 IO、旧 wire 无法一致、持久格式必须迁移、或其他会话覆盖同一闭包，先记录 reports/replan-NNN.md，并按原 owner 重新切片。历史 DONE 不改写； superseded 节点保留证据。不能通过移除测试、扩大 allowlist 或把实现塞进万能 capsule 达成“无环”。

最终对 proposal 的每项成功判据给 current evidence；只声明受影响范围，不给全库无环承诺。交付物包括真实闭包映射、公开入口使用方式、验证命令与残余范围。实现与测试依据后续 impl-mission 授权；不自动提交。

## 8. 执行期映射更新

G1 的实际依赖调查将原“pure rules 回 organ”修正为既有 ai-persistence-logic 的 ConversationProjection/ConversationRecovery，避免 support 再反向引用 organ。G3 按此实现，registry 改为 runtime 实例持有。G4 journal byte-store contract 归 organ-contract、规则留 organ-logic、文件效果归 support；外层 Terminal openLocalHolonTaskRuntime 选择文件 factory/clock，Workflow 只使用 VM 上既有 capability。

G5 的剩余配置/权限规则归既有 core-logic，文件和环境解释归 support；原 organ 子路径保持同实现 facade。Conversation 类型 facade 的 SCC 用原 conversation owner 下的独立类型文件消除。源码门禁保留所有 type/export 边并列出残余 SCC；manifest 明确禁止 support→organ-logic，不把既有 core-contract↔organ-contract SCC 隐藏掉。

G2 记录的既有 B1 多 Actor Workflow 恢复失败由 G6-T0 独立修复 Track 承担，因其阻碍整体成功判据；不将行为纠偏冒充机械重构。详细证据见 reports/replan-001.md、reports/replan-002.md 和绑定 Tracks。
