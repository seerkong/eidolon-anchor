# Design: fix-frozen-session-history

## 方案概述

按证据分层，三个 P 依次落地。每层有独立行为契约与测试，任一层单独完成都能减少伤害，不合并成一个「加兜底」的补丁。

```text
P1  解析器缺陷（零重叠，立即做）
      ↓
P2  turn 结束路径的落盘出口 + 可观测性
      ↓
P3  测试迁移与全量回归
```

## P1：纯赋值段是合法段

**问题。** `collectBashCommandWords`（`LocalPermissionEvaluator.ts:902-953`）跳过段首的 `ENV_ASSIGNMENT_RE` 匹配 token 后，若剩余为空则抛 `Bash segment does not contain an executable command`。该函数同时服务两个不同目的：

1. `normalizeBashSegment` —— 把段归一化成可参与权限规则匹配的字符串；
2. `bashSegmentIsWorkspaceSafe`（`:1109-1121`）—— 判断段是否只读安全。

「空 = 解析失败」对目的 2 勉强成立（无执行命令则谈不上 workspace-safe），但对目的 1 是错的：`D=/path` 是合法段，归一化结果就该是它自己，且该段无副作用、不需要审批。

**方案。** 把「段内只有赋值」当作一个**明确的、合法的**分类，而不是异常：

- 归一化：纯赋值段归一化为其自身（保留赋值文本用于审计），标记为 no-op 段。
- 求值：no-op 段直接跳过规则匹配（无副作用 → 无需 allow/deny/ask），不参与 `serializedTarget` 之外的效果判定。
- 守卫不变：`bashSegmentModifiesProtectedPermissionConfig`（`:980`）仍在归一化前执行，受保护配置路径照旧拒绝；危险命令照旧 ask/deny。
- 「空段」（`tokens.length === 0`，例如 `&& &&`）仍视为解析失败 —— 那是真的畸形输入，与「只有赋值」不同类。

**边界。** 引用了前段赋值变量的段（`tar -xzf "$D/a.tgz"`）按变量名解析，不做展开后的路径字符串匹配去判受保护配置；受保护配置的判定仍走既有 `bashRawCommandReferencesProtectedPermissionConfig`（`:1129`），其行为不变。

**验证。** 直接对 `parseBashCommandSegments` 与 `evaluateLocalToolPermission` 写表驱动测试：

| 输入 | 期望 |
|---|---|
| `A=1 && echo hi` | 解析成功；`echo` 段按既有规则求值 |
| `cd /tmp/x && D=/tmp/y && tar -xzf "$D/a.tgz"` | 解析成功，三段；`tar` 段按既有规则求值 |
| `A=1`（整条仅赋值） | 解析成功；求值判为无副作用 |
| `A=1 && > /protected/permissions.json` | 仍被拒绝（受保护配置守卫不变） |
| `A=1 && rm -rf /` | 仍 ask/deny（危险命令不变） |
| `echo hi && && echo bye` | 仍解析失败（真畸形输入） |

## P2：turn 结束路径的落盘出口

**问题。** `runtime_conversation_flush` 的触发集只覆盖 safepoint 安全的路径。当 turn 以非 safepoint 结局结束（mandatory_continuation、fiber suspended 未回安全边界），flush 不再触发，而 `messageCount` 与 `history.xnl` 的差额（实测 159 条）留在内存里，且`suspended + idle_external` 的 fiber 不再有在途 turn 去提交它。

**方案（待 P2 开工时按已落地基线细化）。** 让「已完成进度」在 turn 结束路径上获得一个 flush 出口，并区分两件事：

- **已完成进度**（已 commit 进 conversation domain 的 user 输入、已收口 assistant、已配对工具结果）→ 在 turn 结束时 flush，无论结局为何。
- **in-flight 进度**（未收口的 assistant、执行中的工具）→ 不 flush 成完成态，也不为此取 VM 快照（保持 P3/seal 既有不变式）。

出口的具体挂点取决于并行 track `harden-turn-settle-budget-contract` 收口后的 turn 裁决形状：该 track 已把 settle 结果改为声明值（`TickDrainOutcome`），并把「stillRunning 且 safepoint safe」也纳入 `timeout_unsettled` 的 seal 路径。本 track 的出口应挂在**同一处**（turn 结束的收口点），而非再开一条独立旁路 —— 否则会形成第二个写者。

`sealCompletedProgress` 是否已足够、还是需要一个更宽的「turn 结束 flush」，是 P2 的实测问题，不预先假设。

**硬约束。**

- 不新增第二个 conversation 写者（单写者不变）。
- 不用「主泵加 `.catch` 吞掉」的方式掩盖。
- 不改变 `timed-out-turn-progress-persisted` 的既有语义。

## P3：搁置可观测 + 全量回归

**可观测。** 当 turn 结束、缓冲仍有未落盘已完成消息且 flush 未成功时，产生非致命结构化告警（会话标识、缓冲消息数、持久化消息数、结局、未 flush 原因）。经事件/可观测通道外溢，宿主记录；不抛错、不中断、不新增写者。这与 `conversation-history-commit-observability` 既有的「孤儿工具结果」「空壳 assistant」告警同形。

**回归。** `cell/packages/ai-organ-logic` 与相关 `terminal/packages/*` 测试面跑通；仓库类型检查通过；不写 `dist/`。

## 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 与并行 track 冲突 | `driverRuntime.ts` / `AiAgentRuntimeCoordinator.ts` 正被另一会话改动，基线未提交 | P1 零重叠先行；P2 开工前重新核对（见 `decisions.xnl`） |
| flush 出口放宽后写入不安全状态 | 若把 in-flight 也 flush，会破坏 seal 不变式 | 显式区分已完成 / in-flight；只 flush 前者；由 P2 测试锁定 |
| 放宽解析器后削弱权限守卫生效 | 纯赋值段被放行，可能掩盖受保护路径写入 | 守卫（`bashSegmentModifiesProtectedPermissionConfig` / `bashRawCommandReferencesProtectedPermissionConfig`）在归一化前执行且不改；测试含受保护路径与危险命令反例 |
| 误判「已修复」 | 观察到的症状由多层叠加造成 | 每层独立测试 + 用真实会话副本复现两侧现象（flush 差额归零、解析不再抛错） |

## 兼容与迁移

- `bash-permission-approval` 语义只放宽「合法但被误判」的输入，不放宽任何「危险/受保护」判定；既有 deny/ask 规则测试不得因此变化。
- `aiagent-persistence-recovery` 新增出口不改变已有 flush 触发点语义，只补覆盖面；既有 seal 测试保持不变。
- 无数据迁移：`history.xnl` 为 append-only，补 flush 只会向前追加已存在的内容。
