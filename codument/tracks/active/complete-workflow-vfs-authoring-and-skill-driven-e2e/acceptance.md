# 验收矩阵与真实模型运行约束

## 历史基线
本 Track 开始前，公开 HolonAssign/MemberAssign 的两个持久任务已成功，但正常 Workflow fresh/existing authoring 在 workspace layer 断言处失败；未产生 Workflow publication/instance/run。父会话超时也未通过。此前离线回归不能代替本 Track 的修复验收。

## 确定性验收
| 编号 | 场景 | 必须观察的结果 |
|---|---|---|
| D01 | 正常 Effective VFS 装配打开既有包、创建新包 | 两入口都可得到可恢复 session；无需虚构物理 layer |
| D02 | 普通文件与 VFS 的共同资源读取/草稿测试 | identity/内容/来源一致；无隐式 root、无读取当前未绑定来源 |
| D03 | 多文件 create/update/delete/move，XNL 与 TypeScript 混合 | 闭包验证后一次 CAS；未改内容字节保留；结构 diff 复用 XNL |
| D04 | 后一文件无效或跨资源引用缺失 | 整候选拒绝，live revision 与所有文件保持原状 |
| D05 | base CAS 冲突、prepare 后编辑、契约/授权/来源漂移 | 原 proof 不可发布，草稿可继续修复 |
| D06 | builtin/home 资源被读到后请求越权修改 | 宿主拒绝；不依赖模型声明的权限 |
| D07 | 准入前失败、准入后投影失败、进程退出、重复 transactionId | 状态与实际效果一致；可查询恢复；不重复准入或效果 |
| D08 | 单文件 AgentDefinition 与整包 Workflow 编辑 | 调用同一写入边界；原正式行为保持兼容 |
| D09 | 标准 Kind 读取、自定义 Kind、缺 schemaRef/伪指纹 | 标准契约可引用，无需每包复制；错误候选被确定性拒绝 |
| D10 | 宿主未绑定与包不存在 | 结构化错误不同；能力故障不走 fresh-create 重试 |
| D11 | 实际 global 安装产物与正常启动 | 相关 system skill 身份/摘要一致，按阶段及任务加载 |
| D12 | 新旧 Workflow 实例、重启后的既有实例 | 旧实例使用冻结版本，新实例显式采用新版本 |
| D13 | 旧 physical 正式模式与生产 effective 模式 | 兼容测试与真实替代链路分别通过，无双 authority |
| D14 | 任务完成到主会话收尾 | 观测 settled、最终答复、正常 CLI 退出；等待不自锁 |

先用现有固定工具链执行 typecheck 和针对性回归，再运行完整生产组合闭环。实现阶段新增的验收脚本应可单独运行，真实 provider 默认关闭。已有 2 秒等待波动需通过可观测 settlement/有界等待解释，不能删除断言或只放大时间来计为修复。

## 真实 E2E
所有 Codex 执行者/独立验证者使用 GPT-5.6 Terra；真实 Eidolon provider 使用用户于 2026-09-12 再次确认的 iqingwa / DeepSeek v4 Pro，精确配置选择，不静默回退 SiliconFlow 或其他模型。历史 Terra live 使用的是 999555999，不能写成 iqingwa。不得把读取开发仓 Skill 文件等同于产品运行时已加载 global system skill。

| 编号 | 用户任务 | 业务与证据 |
|---|---|---|
| L01 | 通过 WorkflowFulfill 创建并运行 AI Data Workflow | 专用 actor 读取相关 Skill/标准契约；真实候选、proof、receipt、instance/run；输出由独立 oracle 验证 |
| L02 | 创建并执行 AI Ctrl Workflow，控制计算与业务 Agent 步骤 | 验证控制图及步骤实际执行、输入输出绑定，不以自然语言说明或模型口算代替 |
| L03 | 编辑既有包并发布 V2 | 旧实例仍使用 V1，新实例采用 V2；新进程回读与恢复一致 |
| L04 | 通过 HolonAssign(final) 和 MemberAssign(final) 派单 | 两条正式路由成功；Worker 自行读取所需知识和实际执行任务 |
| L05 | 上述操作的根会话收尾 | 子任务 settled、父最终答复、CLI 正常退出分别成功；超时或人工终止不算通过 |

执行中核实的范围：L02 采用当前已实现的 Ctrl→Agent 路径。通用 Flow DSL 的 `CallFlow` grammar 不代表 Eidolon 已绑定 Ctrl→AIData 的持久调用 resolver；本 Track 不新增该跨工作流引擎。L03 单独编辑已经实际执行的 Data Workflow，并比较原 V1 与新 V2 的 native publication、冻结定义、checkpoint 及新进程恢复。两个独立工作流运行不能冒称嵌套调用。

每个场景保存操作/包/版本/任务关联 ID、Skill identity/digest、实际工具读取、provider 可见证据、业务回执、预期值与实际值。Skill 安装、读取、provider 可见、公开路由和业务结果分别判定。对未运行、失败或结果未知明确标记，不用部分成功代表矩阵完成。

## 预算与权限
- 每次 live 运行前生成清单：场景、精确 provider/model、最大请求次数、每请求输出预算、全局 token/时长、取消/超时策略。各层共用预算；不把 4096 当作适用于所有工作流的固定上限。
- 明确 authoring/publication/execution 授权，隔离 workspace/home 与产物范围。沿用已有用户授权，额外消费或不可逆动作超出授权时展示具体差额与制品后再确认。
- 无隐式自动重试。传输失败或发布结果未知先查询既有事实；预算耗尽明确 incomplete。实现前离线预算测试须通过。
- Provider 原始请求与会话、凭据配置不提交 Git；提交脱敏摘要。全流程运行不改用户真实组织或资源包。

## 完成条件
D01–D14 与 L01–L05 均有新证据；生产装配不再需要 physical layer 旁路；类型/回归通过；独立验收和最终 DEPA 方向检查无未解决缺口。若 provider 不可用，保留 pending/blocked 验收，不允许以离线通过完成 Track。完整 Halfcode Skill App 迁移仍为后续范围。

## 执行证据索引

状态由 `track.xnl` 管理，下面列出可复跑入口。原始 provider、执行清单和 native 制品只存于被忽略的 `codument/reports/`。

| 范围 | 验证入口 |
|---|---|
| D01/D02/D09/D10 | `effective_vfs_resource_registry.test.ts`、`workflow_resource_backend_conformance.test.ts`；实际 builtin 空工作区、可信 Kind、两个公开创建/打开入口及带位置的候选诊断 |
| D03–D08/D13 | `effective_vfs_package_publication.test.ts`、`effective_vfs_authority.test.ts`、`agent_definition_authoring_adapter.test.ts`；整候选、单次 CAS、响应丢失、投影恢复、SIGKILL、单文件兼容 |
| D11 | `system_skill_split_plan.test.ts`、`system_skill_installer.test.ts`、`global-command.test.ts` 与正常 CLI global init；生成器检查实际分发闭包 |
| D12 | Effective VFS 发布测试中的 V1/V2 执行，以及 native authority/Workflow OS-process recovery；真实制品另由 `scripts/workflow-skill-live-recovery.ts` 新进程恢复 |
| D14/L05 | 四个通过场景均为 CLI completed/exit 0；final message 与领域 settlement 分别核对，历史人工终止场景不计为通过 |
| L01 | Data03 已通过：35 次 DeepSeek v4 Pro 请求，订单原生输出 3948；Terra 独立复核父网关、子阶段知识、非硬编码源码和 native 关联链 |
| L03 | Edit01 已通过：25 次真实请求；V2 discount50/total3898，独立新进程恢复原 V1 total3948 与 V2，冻结字节和原生关联分别核对 |
| L02 | Ctrl06 已通过：21 次真实请求；原生计算 total950，真实业务 Agent 单次 provider 请求返回 approved=true；profile.ai、effect receipt、actor 与输出一致 |
| L04 | Assignments04 已通过：8 次真实请求，父/两个 Worker 分别 4/2/2；HolonAssign 和 MemberAssign 各自 Succeeded/settled、输出3948，Worker 自行读取 Run Skill |

真实运行入口为 `scripts/workflow-skill-live-e2e.ts`，默认只准备隔离环境，必须显式 `--live` 才发送请求。`scripts/workflow-skill-live-evidence.py` 只读核对 native publication、authoring receipt digest、composition、frozen definition、instance/run 和 checkpoint；`--baseline-run` 用于跨版本对照。不能直接把 CLI stdout 或任意 JSON 中出现的 ID/Completed 当作成功。

## 最终验收结果（2026-09-13）

D01–D14、L01–L05 均通过。独立 Terra 验证者实际运行定向测试、类型检查并回读原生和 provider 材料；最终 coding AttractorCheck 无未解决方向缺口。

| 原始运行目录（位于被忽略的 `codument/reports/`） | 请求数 | 计费输出 token | 业务结果 | CLI |
|---|---:|---:|---|---|
| `workflow-skill-live-2026-09-13-data-03` | 35 | 16530 | order-314：1275 + 2398 + 275 = 3948 | completed / 0 |
| `workflow-skill-live-2026-09-13-edit-01` | 25 | 11773 | V2 discount50，total3898；V1 保持3948 | completed / 0 |
| `workflow-skill-live-2026-09-13-ctrl-06` | 21 | 10737 | order-315：850 + 100 = 950；业务 Agent approved=true | completed / 0 |
| `workflow-skill-live-2026-09-13-assignments-04` | 8 | 3254 | 两个独立任务均为3948；均实际读取 Skill | completed / 0 |

每个目录的 `evidence.json` 是只读 oracle 输出。Edit 使用 Data03 的 `--baseline-run`；Data03、Edit01、Ctrl06 分别通过新进程生产读者恢复。Ctrl 状态由生产 `stateProjection` 投影，最终结果读取 `checkpoint.state.__flow_execution__` 中已返回的 output；不能套用 Data 的直接 output 路径。旧 V1 在 V2 发布后仍从原冻结字节恢复。

组织证据由公开调用 ID → pump subscription → 当前 TaskSpace head、settlement/claim → MemberRuntime/session → 声明的摘要校验输出制品逐项关联。当前 Member session 没有直接 providerActorId；这组串行场景要求调用时间范围内唯一 Worker，并核对其实际 provider 输入等于该 subscription.input。Worker 自己收到的 Skill 返回值必须匹配安装材料。自由文本 `value` 的算术由独立验证者阅读核对，脚本中的数字存在性检查不等同于通用语义证明。

最终正式分发为 Run **1.0.7**、Authoring **1.0.30**、DevOps **1.0.35**、Halfcode Resource DSL **1.0.0**，113 文件闭包摘要为 `sha256:1079ae177d2a54184e7defb0433a9d8d7de238e927d47ab9d2f85e6f549ee13a`。默认 global 已通过正式 `eidolon global init` 更新，正常启动使用该分发；早期成功 Data/Edit 的独立安装版本原样保留。Skill 根会经过正式渲染器去除 frontmatter 并附加资源索引，源码摘要与 provider 可见摘要分别保存，不能直接比较二者。

复跑时先按 [resource-ports.md](resource-ports.md) 准备尚未发布的 Halfcode 候选依赖。定向入口示例：

```sh
bun run --cwd cell/packages/ai-organ-logic typecheck:agent-resource-authoring
bun test cell/packages/ai-organ-logic/tests/workflow/workflow_lifecycle_resource_agent_boundary.test.ts cell/packages/ai-organ-logic/tests/workflow/workflow_complete_agent_ctrl_data_e2e.test.ts
bun test scripts/workflow-e2e-provider-budget.test.ts
python3 scripts/workflow-skill-live-evidence.py <已有运行目录> --output <证据文件>
python3 scripts/workflow-skill-live-evidence.py <Edit运行目录> --baseline-run <Data运行目录> --output <证据文件>
```

## 保留的失败与修复原因

失败目录和已有实例不覆盖、不改写。下列历史结果都不计入通过矩阵：

- Data 初次运行因不支持的 CLI 参数退出，零请求；Data02 暴露 builtin manifest 缺版本、草稿自身触发 source drift 和候选业务错误。
- Ctrl01 假设宿主已有 Ctrl→Data resolver；Ctrl02 生成 XNL 语法错误而工具遗漏详细诊断；Ctrl03 的 Agent 输入不符合 schema，错误包装丢失具体原因。三轮均人工终止，exit143。
- Ctrl04 的 lifecycle 工具构建回调被业务 Agent 继承，导致 facet 校验拒绝。现已对 spawn、typed addressed、重复恢复和嵌套生命周期覆盖普通宿主能力传递，业务 Agent 不获得生命周期权限。
- Ctrl05 的 Prompt 指令写在运行时不读取的 Content 槽。Skill 现明确正文写入 `Prompt.template`，角色由 Message 声明；Ctrl06 通过公开编辑修复真实资源并重新发布。
- Assignments01 将多行正文直接截为 canonical 名称，在准入前失败；现仅规范化派生标题，原始输入保持不变。Assignments02 返回说明加 fenced JSON，严格对象 schema 正确拒绝；现要求整条最终消息是 raw JSON，未放宽校验。
- Assignments03 及 Ctrl05 后段遇到本地预算 relay 把成功后的相同请求体误判为重试。现只拦截前次传输 pending/failed/cancelled 的同体重复，成功后的独立业务调用单独计费；传输仍只发一次，没有自动重试。

完整 Halfcode Skill App 拆分和 Ctrl→Data 持久嵌套调用仍为后续范围；本轮没有 npm 发布、Git 提交或 push。
