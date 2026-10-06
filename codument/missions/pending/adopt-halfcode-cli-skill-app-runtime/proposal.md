# Mission: adopt-halfcode-cli-skill-app-runtime

## 背景

2026-09-06 的 Codex 会话（`~/.codex/sessions/2026/09/06/rollout-2026-09-06T21-46-54-01a077ac-...jsonl`）中，用户给出明确方向：

> 在 `/Users/kongweixian/infra-dev/depa-codument/.cdmt-lite/missions/active/codument-cli-skill-app-refactor/` 中，在做一个逐步利用 `/Users/kongweixian/infra-dev/halfcode-cli/halfcode-cli-lite` 中提供的公开包，把 AI 相关的变化快的确定性逻辑、文本指令，从核心中分离，转换为可动态加载的 cli skill app。其实本项目前面曾经做 ai data/ctrl workflow 时，把 AIAgentDefinition 的定义改为能够动态加载，已经是在走这个演进方向了。……我就会接下来根据 depa-codument 的沉淀改造下来的经验，将 eidolon 也彻底的进行拆分 halfcode cli skill app 的改造。

同会话中用户进一步点出关键技术 gap：

> 未来接入 cli skill app 后，这个 ai workflow 的编辑场景，其实是需要 halfcode 提供的那些包，除了提供真实操作系统的读写资源能力，还需要支持当前本项目需要的 VFS 的资源读写能力？

当时的结论是：Halfcode 已有 `ResourceEffect` 读取协议与 `WorkspacePort` 文件操作，但**公开 `HostCapabilityMap` 尚无整包 authoring/publication 能力**；因此本轮先由 Eidolon 的显式 runtime 注入接口，公共化留待后续。

该前置（Workflow 整包 VFS 编辑发布 + skill 驱动真实 E2E）已由 [complete-workflow-vfs-authoring-and-skill-driven-e2e](../../tracks/active/complete-workflow-vfs-authoring-and-skill-driven-e2e/track.xnl) 完成（D01–D14 与 L01–L05 全通过）。本 mission 承接其记录在 [resource-ports.md](../../tracks/active/complete-workflow-vfs-authoring-and-skill-driven-e2e/resource-ports.md) 的「下一阶段」范围。

## 目标

以版本化 `halfcode-cli-lite-*` 公共包为通用 Host 的源码 owner，让 Eidolon 像 depa-codument 一样通过公共契约消费它们；把 Eidolon 中变化快的 AI 确定性操作与文本协议拆为可动态发现、加载的 CLI Skill App。为此公共 Host 必须获得**与存储后端解耦**的资源操作协议，使同一个 Skill App 能同时面向真实文件系统与 Eidolon 的 Effective VFS。

具体地：

1. Halfcode 公共包提供三层资源协议（读取 / 草稿编辑 / 发布准入）与显式能力声明，未提供的后端明确返回 capability unavailable。
2. Eidolon 把已验证的 Effective VFS 三端口绑定到该协议，且资源发现、依赖解析、候选校验与代码材料加载全部走选定来源闭包。
3. Workflow authoring/run 操作族作为首个垂直切片，旧工具与新 Skill App 调用同一 Processor、相同状态裁决与 receipt。
4. 消除 Eidolon 对未发布跨仓源码候选（`.tmp/candidates` 的 `halfcode-compiler.xnl` override）的长期依赖。

## Non-Goals

- 不在本 mission 内做 npm 正式发布，也不覆盖用户本机真实 global 安装（各自独立 checkpoint）。
- 不把 Codument 的实施状态、验收结论或代码当作 Eidolon 的事实来源。
- 不新增 Ctrl→AIData 持久嵌套调用等已明确排除的领域能力（属既有 track 的保留范围）。
- 不重写 XNL 的 diff/mutation/VFS/CAS 原语；这些直接复用现有 `xnl-*` 包。
- 不改动既有 Workflow 实例的冻结语义，也不在运行中替换处理函数。

## 为什么是 Mission 而不是 Track

该目标明显跨两个仓库、跨多个 owner 边界，且执行期存在较大不确定性（公共契约形状、能力声明粒度、分发路径替换的可行范围都需要先取证与设计收敛）。单 Track 无法在一次闭环内同时保证 Halfcode 公共包的独立可复用性与 Eidolon 的领域不退化。

**代码、规范与测试的落地仍由真实 Track 承担**。Mission 只负责期望态 DAG、观察实际态、受控重规划和跨 Track 编排；mission 本身不包含绕过 Track 的直接实现任务。

## TrackLink 使用纪律

每个叶子的创建 / 执行任务只有在操作对象确实是「创建、绑定、执行、验证或归档一个真实 Track」时才挂 `TrackLink`。纯证据盘点、设计收敛、写报告与总目标验证使用普通 `Task`。同一真实 Track 的创建与执行只保留一个权威 `TrackLink`，其他任务在描述中引用其 id。

## 阶段路线

| 阶段 | 目标 | 依赖 | 当前状态 |
|---|---|---|---|
| G1 能力清单与缺口取证 | 两仓能力三分表 + VFS 缺口与归属边界的代码级证据 | 无 | NOT_STARTED |
| G2 Halfcode 公共资源后端协议 | 三层协议 + 显式能力声明 + 独立第三方 consumer 证伪 | G1 | NOT_STARTED |
| G3 Eidolon 接线与标准分发 | Effective VFS 三端口适配；替换私有生成器与未发布候选依赖 | G2 | NOT_STARTED |
| G4 Workflow 操作族首个 Skill App 切片 | 共享 Processor + 操作资源化，新旧入口同裁决 | G3 | NOT_STARTED |
| G5 真实 E2E 与收口 | 冻结/权限语义不退化 + 隔离真实 E2E + 独立验收 | G4 | NOT_STARTED |

## 风险

- **契约形状不确定**：资源后端协议的能力声明粒度与 receipt 形状需要先观察真实消费场景，过早定型会造成返工。
- **分发路径替换范围不确定**：`GeneratedEidolonSystemSkillPlan.ts` 的私有生成路径涉及 113 文件闭包与安装事务，替换范围需在 G3 先取证再决定，可能部分留待后续。
- **跨仓协作**：Halfcode 是独立演进仓库，需逐项合并而非整树覆盖，且不能假设 depa-codument 的改动已经进入 Halfcode 的期望状态。
- **真实 provider 成本**：G5 依赖真实模型调用，需在运行前具象化预算与授权边界。
