# Design：Canonical Holon product cutover and VM path retirement

## 现有双路径

### Canonical 路径（保留并成为唯一执行路径）

| 责任 | 现有代码 | authority |
|---|---|---|
| 声明组织与执行适配 | `holarchy-eidolon-adapter` 的 `HolonExecutionBinding*` | Halfcode resource + File-XNL snapshot/receipt |
| 冻结部署 | `organization/HolonDeploymentDefinition.ts` | immutable deployment definition/freeze receipt |
| 选成员与 claim | `organization/HolonCoordinator.ts` | TaskSpace CAS + frozen Role/Policy |
| 创建成员 runtime | `organization/HolonMemberRuntime.ts` | deployment store + generic actor/session owner |
| 执行并结算 | `organization/HolonWorkflowTaskRuntime.ts` | TaskSpace attempt + durable dispatch journal |
| 连续推进 | `organization/HolonTaskSpacePump.ts`、`HolonTaskSpaceCoordinatorActor.ts` | TaskSpace lifecycle + actor mailbox wake |
| Ctrl/Data 接入 | `workflow/runtime/WorkflowRuntimeService.ts` | Flow checkpoint + exact Holon target proof |

G5 已让 AI Ctrl/Data 自动消费 canonical settlement；这回答了“Holon 是否与 AI workflow 打通”：执行链路已经打通，但旧 VM 产品分支仍未删除，本 Track 完成最终切换。

### 旧 VM 路径（迁移后删除）

| 旧行为/事实 | 代码位置 | canonical 映射 |
|---|---|---|
| 从 TaskTree 找 pending/in_progress | `AutonomousHolonTaskRunner.ts` | TaskSpace ready frontier / live claim |
| 过滤 Holon roster、选择成员 | runner + `OrganizationManager` | frozen snapshot Role/Policy + `HolonCoordinator` |
| 写 TaskTree in_progress | runner | `claimTask` / `startTask` receipt |
| 写 actor `tasks/taskOwnership` | runner、assign core、executor | TaskSpace task/claim/settlement；actor 只保留 governance projection |
| `<autonomous_holon_task>` mailbox envelope | `autonomousHolonEnvelope.ts`、`AiAgentExecutor.ts` | typed coordinator mailbox + `HolonExecutionInvocation` |
| `autonomousHolonTaskSignals` final wait | assign core、VM runtime、driver | terminal TaskSpace receipt / Flow completion |
| `autonomous_holon` lane / `autonomous_holon_task` workload | lane/workload/member/snapshot/coordinator | generic member runtime + task-attempt session |
| claim/idle event methods与history stream | event graph、runner、executor | TaskSpace history/settlement + generic workflow/actor progress projection |
| idle worker shutdown | runner timer | reconstructible coordinator wake、lease expiry与通用 runtime lifecycle |
| final/none/stream reply | assign core/executor | canonical submission receipt及订阅投影；不是第二个状态机 |

## 产品 cutover

`HolonAssign` 和 `ActorAssign` 名称继续保留。两者的 autonomous 分支调用同一个 `CanonicalHolonAssignmentFacade`。Facade 本身不保存 task 状态；`WorkflowRuntimeService` 在冻结 workflow resource context 中为每个真实 `FrozenHolonTaskTarget` 投影一个仅存在于当前 VM 生命周期的 typed assignment authority：

```text
HolonAssign / ActorAssign
  -> resolve governance target (read-only product projection)
  -> resolve exactly one runtime-only authority projected from FrozenHolonTaskTarget
  -> open canonical TaskSpace and durable pump subscription
  -> wake the same HolonTaskSpaceCoordinatorActor / MemberRuntime chain as Ctrl/Data
  -> return task/subscription/settlement receipts only
```

Authority 解析只接受一个 exact frozen root Holon。零个 authority 返回 `canonical_holon_binding_required`；多个 authority 返回 `canonical_holon_binding_ambiguous`，不得按名称相似度、最近运行或 VM 成员列表猜测。VM Holon 的名称/identity 只用于把交互目标映射到 frozen root，不能证明成员、Role、Policy 或执行适配；这些事实仍由 File-XNL snapshot 与 binding receipt 决定。

AI Ctrl/Data 由 frozen workflow node 自带 `HolonTaskTarget`；product assign 复用该冻结上下文投影出的 authority。三者最终都通过 `WorkflowRuntimeService` 打开 canonical TaskSpace、持久化 pump subscription、唤醒 coordinator actor，并由 generic MemberRuntime 的 task-attempt session 执行。`final`、`none`、`stream` 只改变返回的观察语义，不创建不同 task state machine。普通 VM Holon 仍可被创建、列出、加成员和观察 governance，但不能再借旧 task board 执行 autonomous work。

## Actor 与 snapshot 收敛

Autonomous Holon actor 只保留 identity、governance、member refs 与 watch state；不再含 task status、ownership、result text、deployment 或 subscription authority。Canonical deployment/subscription facts分别归 File deployment store 与 pump journal；`CanonicalHolonTaskAuthorityState` 只是 G5 coexistence 期间的过渡证明，已随旧 writer 删除，避免把 migration fence 误当成长期 product model。

旧 snapshot 不承诺透明恢复。Actor decoder 只保留 governance/mailbox 作为只读审计与产品投影，并在创建 live actor 前丢弃 task facts。恢复入口在 effect gate 与 scheduler 重建之前过滤 `autonomous_holon` lane 或 `autonomous_holon_task` workload；这些旧 fiber 不进入 restored fiber map、child completion map、detached registry 或 dispatcher。其余未知 workload 直接判为 unsupported snapshot，不能再被 unchecked cast 后降级为 interactive。

## TaskTree 边界

一般 TaskTree 继续作为无 AI workflow 时的 planning UI/tool，并不等同于 Data RunGraph 或 TaskSpace。删除的是 `activeForm=holon:*` 触发 autonomous scheduling 的解释规则；TaskTree 中的文本可被用户显式迁移为 canonical task input，但 TaskTree status 不再随 Holon 执行双写或反向投影。

## 删除顺序

1. 先建立旧行为 → canonical 测试矩阵，锁定保留语义和明确废弃语义。
2. 让 `HolonAssign`/`ActorAssign` 只调用 canonical facade，并证明 missing binding fail closed。
3. 删除 executor 中 envelope relay/drain/waiter、special lane/workload/event/snapshot 分支。
4. 删除 runner/controller/envelope/assign core 和旧专属测试。
5. 静态扫描旧 symbol/字符串为零，再运行 fresh recovery 和 Ctrl/Data regression。

## 风险与控制

- **误删一般 TaskTree/member**：静态删除清单只匹配 autonomous 专属语义，并保留普通 TaskTree/member regression。
- **把 tool facade 变成第二 authority**：facade 不保存状态，只返回 TaskSpace/Flow receipts。
- **direct assign 悄悄降级**：没有 frozen binding 必须返回稳定错误码，禁止投递 VM mailbox。
- **旧 session 恢复重启 writer**：fresh recovery 测试加载旧字段后必须无 special fiber、无 TaskSpace 写入能力。
- **Ctrl/Data 回归**：G5 自动 pump tests 与 G4 dynamic Agent recovery E2E 都纳入验证；G7 再做完整递归产品矩阵。

## 验证矩阵

- product `HolonAssign` 和 `ActorAssign`：一个 exact frozen authority 时，`final/none/stream` 都产生并结算 canonical TaskSpace receipt；无 authority 时明确拒绝；全过程没有 VM task mutation。Ctrl/Data frozen Holon node 使用同一 coordinator/MemberRuntime 链。
- claim race、roster/policy、multi-task dependency、lease/idle、accepted effect replay、stale result、failure settlement、fresh process recovery。
- final/none/stream 仅为同一 durable task 的观察策略，模式切换不改变 authority。
- 一般 TaskTree、member、leader-led Holon 回归不受影响。
- source scan 不含旧四文件引用、envelope tag、waiter store、special lane/workload/event stream/API。
- fresh coding AttractorCheck 独立确认行为 parity 后才允许完成 Track。
