# Design: adopt-halfcode-cli-skill-app-runtime

本文件记录本 mission 的控制目标、事实源、关键缺口证据、期望态与风险。执行状态只在 `mission.xnl`。

## 0. Attractors

吸引子约束计划、决策、实现与校验；测试通过但违反排除集，仍按 drift 处理。

| ID | 路径 | 管什么 |
|---|---|---|
| AT1 | [host-and-domain-boundaries.md](attractors/host-and-domain-boundaries.md) | 通用 Host / Eidolon 领域 / 双方契约的归属与依赖方向 |
| AT2 | [resource-backend-and-vfs.md](attractors/resource-backend-and-vfs.md) | 资源读取 / 草稿编辑 / 发布准入三层语义与 VFS 不变量 |
| AT3 | [compatibility-cost-and-evidence.md](attractors/compatibility-cost-and-evidence.md) | 旧行为兼容、验证强度、上下文成本与证据分层 |

## 1. 事实源（2026-09-13 观察）

以下均为读源码/产物得到的事实，不是外部项目状态的转述。

### 1.1 Eidolon 现状（#host）

| 事实 | 证据 |
|---|---|
| 已有 skill 资源分发，且已用 halfcode-compiler 的 SkillCapsule | `cell/packages/ai-support/src/system-skill/resource-package/manifest.xnl`（`ResourcePackage #Eidolon.Anchor.SystemSkills.Package`，Catalogs: KindDefinitions + SkillCapsules）；`SystemSkillInstaller.ts:288` 调 `applySkillCapsuleDistributionPlan`；`.system-skills.xnl` schema v3 |
| 分发计划是私有生成文件 | `cell/packages/ai-support/src/system-skill/GeneratedEidolonSystemSkillPlan.ts`（1248 行，`halfcode.skill-distribution/v1`，内嵌 base64 payload） |
| 已安装的 4 个 system skill | `~/.eidolon/skills/`：Authoring 1.0.30、Run 1.0.7、DevOps 1.0.35、`sys-halfcode-resource-dsl` 1.0.0；113 文件闭包 |
| 已有动态 AIAgentDefinition 加载 | `cell/packages/ai-organ-logic/src/resources/EidolonAutonomousAgentResourceHost.ts`、`EidolonAIAgentDefinitionAuthoringAdapter.ts` |
| 已有 Effective VFS 三端口 | `cell/packages/symbiont-logic/src/resource/EffectiveEidolonVfsAuthoring.ts`、`EffectiveEidolonVfsMaterializer.ts`、`EffectiveEidolonVfsPublication.ts` |
| Workflow 操作面规模 | `WorkflowToolCatalog.ts`：2 public gateway + 47 lifecycle/definition 工具；`WorkflowStageToolCatalog.ts`：9 个阶段各自的工具白名单 |
| **未依赖任何 `halfcode-cli-lite-*` 包** | `grep -rn "halfcode-cli-lite" --include=*.json --include=*.ts`（排除 node_modules/.tmp）零命中 |
| 消费未发布跨仓候选 | 根 `package.json`：`overrides: {"halfcode-compiler.xnl": "workspace:*"}`；workspaces 含 `.tmp/candidates/packages/halfcode-compiler.xnl`；`scripts/prepare-halfcode-trusted-kinds-candidate.ts` |

### 1.2 Halfcode 公共能力现状（#halfcode-cli）

| 事实 | 证据 |
|---|---|
| 17 个公开 SkillApp Kind，含 `CommandOperation` | `packages/skill-app-contract-public/src/resource.ts` 的 `SKILL_APP_RESOURCE_KINDS`；`CommandOperation` 有 `spec.command`/`description` 与正文（`textRequired: true`） |
| 资源读取协议是只读四操作 | `packages/cli-host-contract/src/resource.ts`：`ResourceEffect { stat, readDirectory, readText, readBytes }` |
| 文件端口面向 OS 且无准入语义 | `packages/skill-app-contract-public/src/host.ts`：`WorkspacePort { root, exists, kind, readText, writeText, writeTextAtomic, makeDirectory, copy, remove }` |
| `HostCapabilityMap` 无 authoring/publication | `packages/skill-app-contract-public/src/runtime-host.ts`：`workspace / sqlite / clock / ids / pageWorkflow / page / pageTargets / configuration / database / browserWebApi` |
| 已有 CommandOperation 顶层命令投影 | `packages/skill-app-logic/src/command-operation.ts`（`appendCommandOperations`）；depa-codument 的 `runtime.ts` / `command-registry.ts` 已消费 |
| 独立消费方证明机制已存在 | `scripts/prepare-release-set.ts`（内容寻址 release set + `release-set.json` digest）、`scripts/clone.ts`（scaffold 第三方产品）|

### 1.3 depa-codument 的集成方式（外部参照，非本 mission 事实）

- clone 骨架通过精确版本消费公共包：`halfcode-cli-lite-cli-host-{contract,logic,support,shell,capsule}@0.1.0`、`halfcode-cli-lite-skill-app-{contract,logic,support,capsule}@0.1.1`、`live-host-capsule`、`http-shell`、`browser-support`；领域包才是 `depa-codument-*`。
- 公共包**尚未发布 npm**：`bun.lock` 解析到 `http://127.0.0.1:65415/artifacts/<sha256>.tgz`（本地内容寻址制品）；消费验收用 `CODUMENT_VERIFY_RELEASE_SET`，缺制品时明确 `UNVERIFIED` 而不回退源码路径。
- global App 经固定根 `ResourceEffect` 加载 `manifest.xnl`，把 `CommandOperation` 投影为顶层命令。

## 2. 核心缺口

**Eidolon 的 Effective VFS 无法被动态加载的 Skill App 访问。**

- 动态加载路径只经公共 Host，而公共 Host 的资源访问止于 `ResourceEffect`（只读、无逻辑 URI、无 revision）与 `WorkspacePort`（OS 文件、无整包提交、无回执）。
- 因此 Skill App 若要读取/编辑 Eidolon 运行实例的资源，只能降级为物理路径写入——这正是 AT1 与 AT2 的排除项。
- 只替换 `readText/writeText` 而保留底层物理目录假设会重演既有故障类型：业务操作支持 VFS，但资源发现/依赖解析/候选校验/代码材料加载仍要求物理目录。

三个新增公共能力的归属按 AT1：**协议与接口归 Halfcode，具体裁决归 Eidolon，结构原语归 XNL**。

## 3. 期望结果

- 期望-1: Halfcode 公共包提供版本化资源后端协议，覆盖资源读取（逻辑 URI/identity/revision）、草稿编辑（文件集 mutation/working revision）与发布准入（expected revision/完整候选/提交关联/receipt/query-recover）；后端显式声明支持的能力集合，未提供者返回 capability unavailable，不伪造 CAS。
- 期望-2: 存在一个非 Eidolon、非 Codument 的最小第三方 consumer，仅安装已打包的版本化公共制品即可注册并使用新增资源后端能力与一个 CommandOperation；运行不读取任一源码树、不依赖 workspace hoist。
- 期望-3: Eidolon 的 Effective VFS 三端口绑定到该协议，且资源发现、依赖解析、候选校验与代码材料加载全部使用选定来源及其闭包；需要磁盘材料的执行器使用受校验的受控缓存，缓存不承担 authority。
- 期望-4: Workflow authoring/run 操作族收敛为共享 Processor；旧工具与新的 Skill App 调用同一 Processor，得到相同的状态裁决与 receipt，不按入口复制多套编排。
- 期望-5: 动态加载只改变操作的发现与调用入口。资源 authority、工具授权、CAS、工作流实例冻结与恢复责任不变；新调用可采用重新准入的定义，执行中的操作与既有实例继续持有原冻结闭包；记录本次操作的 FQN、material digest 与契约版本。
- 期望-6: 旧 CLI 入口、argv/JSON/退出码契约与既有工具行为在拆分期间保持兼容；新资源式入口不使旧路径无法启动。
- 期望-7: 消除对未发布跨仓源码候选的长期依赖，改用版本化发行物；本轮无法完成的部分留下明确的替代路径与未决项，不声称已公共化。
- 期望-8: 隔离 workspace/home 下的真实 E2E 覆盖 Data/Ctrl 工作流创建执行、既有包编辑发布与新实例版本对比，并保留 Holon/Member 派单回归；Skill 已安装、已加载、provider 可见、公开路由与业务结果分别判定。
- 期望-9: 系统 skill 的安装来源与它编辑的目标资源显式分离（前者可为已安装磁盘包，后者为 Effective VFS），两者不共享隐含 root；调用不另建一份空 VFS 冒充运行实例。

## 4. 约束

- 约束-1: 通用能力的源码 owner 是 Halfcode；Eidolon 不维护同义第二实现。公共包不得 import Eidolon 领域包、硬编码 Eidolon 路径或经外部源码路径运行。
- 约束-2: Eidolon 保留领域权威：Effective VFS 准入、工作区写权限、Workflow session/实例冻结、执行状态与恢复。公共 Host 不承担 Holon/Workflow 领域裁决。
- 约束-3: 业务 Skill App 只获得窄能力；不新增 arbitrary invoke/eval/万能 argv RPC 通道，不用 workspace 写入旁路准入。
- 约束-4: 不重写 XNL 的 AST、结构 diff/mutation/apply 与 VFS revision/CAS；直接复用现有 `xnl-*` 包。
- 约束-5: 同一目标事实的 live authority 唯一。同一次运行不得同时用 physical publisher 与 Effective VFS 独立裁决相同事实；旧 physical 模式如仍需保留，须是显式适配器并通过双后端 conformance。
- 约束-6: 统一契约不要求各后端能力相同；共同能力集与可选能力须在测试中显式区分，不得以伪造 CAS 通过。
- 约束-7: 跨仓改造逐项合并，不以整树覆盖；不假设 depa-codument 的改动已进入 Halfcode 期望状态，也不引用 depa-codument 私有源码运行 Eidolon。
- 约束-8: 发送真实 provider 请求前生成运行清单：场景、精确 provider/model、最大请求次数、每请求输出预算、全局 token/时长、取消与超时策略；超出现有授权先提决策，不把预算耗尽写成成功，无隐式自动重试。
- 约束-9: 隔离验证。真实 E2E、安装与升级在隔离 workspace/home 下执行；不静默覆盖开发者当前真实 global 安装或既有 dogfood 状态。
- 约束-10: 不在本 mission 内 npm 发布或覆盖本机全局安装；二者为独立 checkpoint。
- 约束-11: 验证强度不降：不关闭检查、不降低已配置轮数、不复用本应 fresh 的语义 verdict、不删必要负例；不修改被测 Agent 的验收标准或框架源码来让结果通过。
- 约束-12: 上下文经济性：Skill 根只提供入口与路由，按任务加载相关操作与精确契约；父 Agent 与 Worker 各自取得所需知识与能力，不假定继承正文。
- 约束-13: 标准 Kind 与安装契约由公共提供方持有；业务 App 引用而非复制系统 KindDefinition。自定义 Kind 走明确的契约定义流程。
- 约束-14: 版本化消费。源码存在、本地 pack、`.tmp` 候选、本地 release set 都不等于已发布；报告须区分「已打包可安装」与「已发布公共包」。
- 约束-15: 不把 mission 当成绕过 Track 的实现通道；代码、规范与测试落地由真实 Track 承担。

## 5. Acceptance

- [ ] 期望-1、约束-1、约束-3、约束-6 → 公共包契约测试 + 双后端 conformance → 三层协议可表达；能力声明显式；缺失能力返回 unavailable 而非伪造 CAS；越界/未知 Kind 失败关闭。
- [ ] 期望-2、约束-1、约束-7、约束-14 → monorepo 外第三方 consumer 隔离安装与运行 → 不读任一源码树、不依赖 hoist；注册资源后端能力与 CommandOperation 均可用；缺制品时明确 UNVERIFIED 而非回退源码。
- [ ] 期望-3、约束-2、约束-4、约束-5、约束-6 → Effective VFS 接线测试（含 file/VFS 双后端 conformance） → 发现/依赖解析/候选校验/材料加载全走选定来源；缓存非 authority；单一写入路径。
- [ ] 期望-4、约束-1、约束-5 → Processor 共享测试 + 新旧入口对照 → 旧工具与 Skill App 同裁决同 receipt；无按入口复制的编排。
- [ ] 期望-5、约束-2 → 动态加载冻结与授权的负例 → authority、工具授权、CAS、实例冻结与恢复不变；执行中实例保持原闭包；记录 FQN/material digest/契约版本。
- [ ] 期望-6、约束-11 → 既有 CLI 契约与旧工具回归 → argv/JSON/退出码兼容；旧路径仍可启动；负例未被删除。
- [ ] 期望-7、约束-14 → 依赖图与发行物核对 → 不再经 `.tmp` 候选运行；未完成部分有明确未决项与替代路径。
- [ ] 期望-8、约束-8、约束-9、约束-10、约束-12 → 隔离环境真实 E2E + 独立验收 → Data/Ctrl/Holon/Member 场景分别判定并保留证据；预算清单与实际消费可追溯；未授权动作未发生。
- [ ] 期望-9、约束-2、约束-12 → Skill App 来源与编辑目标分离测试 → 两来源不共享隐含 root；不新建空 VFS 冒充运行实例。
- [ ] 约束-13、约束-15 → 契约复用与 Track 纪律审查 → 系统 Kind 不复制；TrackLink 只挂真实 Track 生命周期。

## 6. 重规划条件

- 观察发现公共资源后端协议的最小形状与预期显著不同（例如 XNL 层已提供更强的现成契约），需要重设 G2 范围。
- 分发路径替换在 G3 取证后确认超出一轮可行范围，需要把 G3-T2 拆到后续 mission 并调整 G4 前置。
- 跨仓契约变更需要用户裁决（命名、版本策略、是否进入 Halfcode 主线）。
- 出现受保护区变更（真实 global 安装、npm 发布、跨仓 Git 历史改写）。

## 7. 关键证据入口

| 范围 | 入口 |
|---|---|
| Mission 控制面 | `codument/missions/pending/adopt-halfcode-cli-skill-app-runtime/mission.xnl` |
| 前置结论与三端口 | `codument/tracks/active/complete-workflow-vfs-authoring-and-skill-driven-e2e/resource-ports.md` |
| 后续演进边界 | `codument/backlog/workflow-effective-vfs-and-skill-app.md` |
| 历史会话原始取证 | `~/.codex/sessions/2026/09/06/rollout-2026-09-06T21-46-54-01a077ac-...jsonl`（已导入专用库 `~/.depa-si/eidolon-halfcode-skill-app.sqlite3`） |
| 外部参照 mission | `/Users/kongweixian/infra-dev/depa-codument/.cdmt-lite/missions/active/codument-cli-skill-app-refactor/` |
| 公共包源码 owner | `/Users/kongweixian/infra-dev/halfcode-cli/halfcode-cli-lite/packages/` |
