# 公共 Holarchy 接入设计

## 事实归属与执行路径

组织 identity、历史、ChangeSet、Command、治理校验、三方调和与有效快照发行归公共 Holarchy 包。Eidolon 的 HolonExecutionBinding 拥有成员到执行 adapter 的绑定；HolonTaskRuntimeCapability 统一 Product-only、Ctrl、Data 的服务入口。File TaskSpace 拥有 task、claim、assignment、result、settlement；Workflow checkpoint 消费 receipt，恢复 journal 只记录恢复材料。

执行路径为：公共原生场景 → 公共提交或调和/显式选择 successor → File-XNL authority → 公共发行 → exact resource admission → execution binding → 同一 TaskRuntimeService → TaskSpace receipt。组织与绑定升级形成新 admission；旧任务继续验证已冻结的组织、绑定与 Agent 配方。

## 直接复用的公共 API

| 公共包入口 | Eidolon 接点与职责 |
| --- | --- |
| `createSyntheticTeamFixture(options)` | 为 reviewer、auditor、worker 注入稳定 member/role/membership identity 和职责参数；返回生产 OrganizationState，不再手写三套 authority tables |
| `createFixtureSeedChangeSet(state, id)` | 将合成初始状态形成显式组织写入；数据期望不调用 diff/planner 自我生成 |
| `issueOrganizationFixture(capsule, input)` | 将真实 capsule、authorization、clock、bounds、实际 issuer version 传给公共 helper，返回 canonical snapshot/receipt bytes、commit 与 provenance |
| `organizationScenarioCatalog()` / `decodeOrganizationScenario()` | 使用已保存的原生 XNL 与独立 expected；首批选择 `atomic-transfer`、`same-field-conflict`、`retired-target-independent-rename`，按宿主实际执行记录 fixture digest |
| `runOrganizationScenario(runtime, scenario)` | 复用公共观察、preview、commit、reconcile、successor 对比协议；Eidolon只提供真实宿主端口。公共 F 结果不能直接冒充 E；E 还须完成资源采用和任务派单 |
| `compareScenarioEvidence()` | 比较共享 expected 与消费者实际 observations；保存 host、versions、entryPoints、PASS/FAIL/NOT_RUN，不能把缺少执行端口算作通过 |
| `stringifyLiteral()` | 必要的资源原生 literal 序列化；去除本地递归字符串拼装，不把业务对象的 kind 字段当 AST |

这些 API 已存在于上游公开源码。候选版本以进入实现时的包清单和 tarball 证据为准，不将外仓 source alias 当成发行边界。组织推理 runtime 由公共 inference capsule 注入，Eidolon 不拷贝规则或 support graph 算法。

## 源码与资源改动面

工作目录 `cell/packages/ai-organ-logic`：

1. `tests/workflow/fileXnlHolonE2eScenario.ts`、`tests/workflow/fixtures/holonRepairResourceProductPackage.ts`、`tests/workflow/holon_execution_binding_registry.test.ts` 改为公共 fixture 数据；保留现有测试所需成员与角色引用。
2. `tests/workflow/fileXnlHolonIssuerFixture.ts` 成为公共 issuer helper 的薄装配；读取或注入真正安装候选的 package version。不得继续把固定旧版本写进 provenance。
3. `tests/workflow/materializeFileXnlHolonE2eResource.ts` 保留 runtime-first IO 壳。`tests/resources/holon-task-e2e` 冻结为历史兼容样例；新增 `tests/resources/holon-task-native-e2e` 承担当前生成与检查。旧 record/tree/receipt/issued 文件逐字节固定。
4. `tests/workflow/fixtures/holonRepairResourceProductRuntime.ts` 保留 registry、VM、TaskRuntimeService、adapter、external acceptance 和独立 `verifyProductArtifact`。将 provider runtime 作为显式装配项，以复用同一产品路径进行 deterministic 和 live 验收。
5. `cell/packages/holarchy-eidolon-adapter` 保持公共 parser、KindDefinition exact bytes 和绑定 semantic fingerprint 校验；新增 native 当前发行与历史原始发行双兼容证据。
6. 必要依赖涉及 `ai-organ-logic`、`holarchy-eidolon-adapter`、`ai-organ-contract`、`ai-support` 和 lock。只更新实际受影响闭包，保留已有无关工作树。

`snapshotBytesBase64`、`issuanceReceiptBytesBase64`、`bindingBytesBase64`、`definitionBytesBase64` 是 exact bytes 传输信封；它们继续保存原始证明，不属于此次删除的领域 `xxxJson` 字段。

## E/P 验收矩阵

| 场景 | 必须观察的结果 |
| --- | --- |
| 原生数据与 E01 兼容 | 三处 fixture 无字段字符串包装；公共 helper 提交、重开、发行；旧 v1 与 issued bytes digest 不变，损坏证明 fail closed |
| E08 Product-only | 无 Workflow 也经过真实 registry/binding/TaskSpace 派单、执行、observe 与 repair；独立文件 verifier 通过 |
| E09 Ctrl/Data | 两条入口使用同一 TaskRuntimeService 与相同 task receipts；不存在第二任务 owner |
| E10 新旧组织 | 公共冲突 preview 不写正式 authority，显式 successor 提交后新发行/新 admission被采用；旧任务与旧 deployment 在新 PID 仍使用旧组织及绑定 |
| E11 恢复窗口 | effect 已接受但 settlement 前，以及 settlement 后 Workflow 尚未消费；独立 PID 恢复且同 external idempotency key 只接受一次 |
| E12 adapter | ai-agent 有一次远端真实 Product-only gate；human-endpoint/service/hybrid 的 envelope 和组织 eligibility 各有独立断言，不从 principalKind 自动推断 adapter |
| E13 消费边界 | 安装与解析 provenance、public exports、候选 version/lock 一致；最终 tarball 隔离验收由发布候选阶段收集，源码别名运行仅作开发诊断 |

## 有界真实 provider gate

新增入口拟为 `scripts/holonProductLiveGate.ts`，由 `EIDOLON_HOLON_LIVE=1` 显式开启。默认从本机既有 provider catalog 中沿现有选择逻辑选兼容 adapter 的 provider 与模型；允许显式选择既有 provider，但不创建或修改账号配置。预检只记录配置字段是否具备，不打印凭据或完整配置。

Gate 建立临时原生组织并发行，admit Worker binding，打开真实 standalone Holon runtime，提交一个小型合成订单任务。host 将确定性的输入 digest 作为请求元数据提供，模型只需复制该 digest 并计算整数金额；独立 verifier 重新计算 digest、每行金额和含运费总额。模型输出由真实 external artifact effect 落盘，不能在回调中修正结果。资源注册、provider adapter、stream parser、TaskSpace settlement 与 observe 均走产品实现。

所有 actor 共用一个请求预算：总计最多 2 次 provider HTTP 请求，输出 token 上限 16384/请求，整个 gate 最多 180 秒。禁自动网络重试、Agent 无限 continuation 和测试循环重跑；超限在发送前拒绝。用合成 transport 的控制测试先证实第 3 次请求不会发出、timeout 会中止、秘钥不会进入报告。live 开启后只运行一次，失败保留真实失败，不补发绕过预算。

报告记录实际请求数、实际 provider token usage（缺失就标 unknown）、耗时、模型/adapter 的非敏感身份、TaskSpace receipt、artifact verifier 与错误分类。catalog 没有 pricing 时 monetary cost 标 unknown；不编造单价或美元上限，不购买套餐或改计费。费用及范围决策见本目录 `decisions.xnl`，已按 Mission 现有授权收敛，无新增用户确认门槛。

## 验收命令与执行顺序

上游共享场景阶段完成后已执行接入。统一确定性门控为根目录 `bun run verify:holon-shared`，它读取实际解析版本，显式采用仓内 `cell/tsconfig.json`，包含以下测试与当前新增场景。

在 `cell/packages/ai-organ-logic`：

```sh
bun run check:holon-e2e-resource
bun run typecheck:holon-execution-binding
bun run typecheck:holon-task-runtime
bun test tests/workflow/holon_execution_binding_contract.test.ts tests/workflow/holon_task_runtime_definition_projection.test.ts tests/workflow/holon_task_runtime_capability.test.ts tests/workflow/holon_task_runtime_processor.test.ts tests/workflow/holon_task_runtime_service.test.ts --timeout 30000
bun test tests/workflow/holon_execution_binding_registry.test.ts tests/workflow/standalone_holon_task_runtime_file_e2e.test.ts tests/workflow/standalone_holon_task_runtime_product_routing.test.ts --timeout 60000
bun test tests/workflow/holon_repair_resource_product_loop.test.ts tests/workflow/holon_product_provider_transport.test.ts tests/workflow/holon_product_session_prefix.test.ts --timeout 65000
bun test tests/workflow/holon_task_os_process_recovery.test.ts tests/workflow/holon_product_process_recovery.test.ts --timeout 65000
```

新增 shared scenario consumer、native/history fixture 和 live-budget control 测试纳入相应 scripts。真实 gate 在 deterministic 通过后单次运行：`EIDOLON_HOLON_LIVE=1 bun run scripts/holonProductLiveGate.ts`。在 `cell/packages/holarchy-eidolon-adapter` 执行 `bun test` 与 `bun run typecheck`。

子进程用显式 `EIDOLON_TEST_TSCONFIG` 指向仓内候选解析配置；审计最终 resolution，防止本地外仓 source override 偷渡。Eidolon 产品测试是 Bun 宿主；公共包 Node/Bun 验收与 tarball 独立消费分别记录，不扩大此处证据的含义。

## 完成门槛

全部 E/P 场景须有实际 evidence，NOT_RUN 不能折算为 PASS。发生外部服务不可用时保留阻断原因供 Mission 处理；不能换成 loopback 宣称 live通过。历史字节、唯一 owner、exact admission、版本 provenance 与已批准请求预算都通过后才允许该 Track 进入完成状态。

## 实施澄清

公共空 ChangeSet 返回 unchanged，不因仅改变发行时间而制造组织 revision。需要 revision 2 的任务重规划用例显式修改成员名称；不变组织重新发行继续指向 revision 1。

Coordinator 当前只派单给目标 Holon 的直接有效 membership。共享 atomic-transfer 场景分别签发并采用 team-a 与 team-b 的任务 runtime，验证成员转移后的角色和旧任务冻结；没有把此场景扩成递归派单语义。相同 VM 拒绝替换 registry revision，新采用使用独立 VM 装配并保留旧 deployment/TaskSpace。

候选锁为根目录 `holon-candidates.json`（name/version/SHA-256）。`bun run prepare:holon-candidates --from <tarball-directory>` 先验证整个输入，再从公共发行物解包生成忽略目录中的候选 workspaces；之后运行 `bun install`，已有本地锁可运行 `bun install --frozen-lockfile`。Bun 的 `bun.lock` 遵循仓库现有 gitignore 策略，不强制加入 Git。Halfcode 消费者继续使用 0.3.1。候选 workspace 不绑定外仓源码。

真实 gate 采用更紧的 provider 175 秒 deadline 与产品观察 177 秒 deadline，为 180 秒总边界留出装配和清理时间。Live 控制与真实产品验证分开测试；错误订单仍留下真实已接受 artifact，但验收 FAIL。

## 2026-09-12 用户确认的预算修订

原512token gate实际达到length结束但没有正文。用户明确同意新的16384token单请求上限和180秒总预算，最多2请求、无自动重试。测试provider默认512仍用于兼容回归；真实gate通过EIDOLON_HOLON_LIVE_OUTPUT_TOKENS=16384显式选择新预算，provider175秒与产品观察177秒为清理留余量。所有历史失败保留原报告，不改写为成功。最终真实模型输出经原独立订单校验，并将校验细节写入报告。
