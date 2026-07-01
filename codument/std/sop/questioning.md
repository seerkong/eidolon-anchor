# 问答协议（std/sop/questioning.md）

> 从原 `std/protocols.md` 拆出的「提问」域。skill 经 `<ask protocol="...">` 引用。

## 通则

- **只在必须澄清/选择/确认时提问**；禁止为"测试运行环境能否提问"而发占位问题。
- 当前步骤无需立即提问就直接继续。
- 优先一次问清互不依赖的问题，减少往返；但有依赖的问题必须按决策树从最阻塞的前沿节点开始问。
- **能查证就不问用户**：凡能从代码、测试、schema、config、现有 behaviors/modeling/engineering/decisions 中确认的问题，先查本地文件并写入 Evidence；只有用户意图、取舍偏好、不可逆策略才提问。
- **澄清即沉淀（file-in/file-out）**：澄清过程中一旦某概念/行为/policy/架构**被澄清并稳定**，**当轮就**把它写回对应 owner registry（领域结构进 `codument/modeling`，长期工程知识进 `codument/engineering`，通过对应 delta 管理；legacy docs 只按项目配置同步），按 `knowledge-tiers.md` 路由，不要让结论只留在对话或拖到归档。未稳定的猜测留 track，不污染 owner registry。

## Questioning Severity

plan-track / plan-mission / discuss 可显式指定 questioning severity；**未指定时默认 `light`**。

| severity | 适用场景 | 问答预算 | 行为 |
|---|---|---:|---|
| `auto` | 高自主、无问答、批量自动化、用户明确要求不要停下来确认 | 0 轮 | 不向用户提问；track/mission 名称、默认 hook、提交模式、校验模式等都自行推断；把假设写入 `analysis/decision-tree.md`、`decisions.md`、`proposal.md` 或 `design.md`。 |
| `light` | 默认规划 | 最多 3 轮，每轮最多 2 题 | 只问 P0 用户意图 / 不可逆取舍；能查代码/文档就不问。 |
| `normal` | 复杂功能或架构变更 | 最多 8 轮，每轮最多 3 题 | 问 P0/P1；每题必须给推荐答案和取舍。 |
| `deep` | mission、跨仓库、长期架构收敛 | 最多 16 轮，每轮最多 3 题 | 允许深挖，但每轮必须更新文件并收敛 decision frontier。 |

触发词映射：

- 用户说“无问答 / 高自主 / 自动推进 / 不要问我 / no-question / auto” → `severity=auto`。
- 用户说“轻量 / 默认 / 快速规划”或未指定 → `severity=light`。
- 用户说“仔细问 / 正常澄清” → `severity=normal`。
- 用户说“深挖 / grill / 详细盘问 / mission 级不确定性” → `severity=deep`。

`auto` 是显式无问答模式：**不得**因 track-id / mission-id 命名、proposal/design/track.xml/mission.xml 确认、提交模式、校验模式、方向审查范围而停下来问用户。若存在高风险假设，写入文件并选择保守默认；实现/归档阶段再用 validate、verify、gap-loop 暴露问题。

注意：`severity=auto` 是“提问自主度”轴；`CommitMode=auto` 是“是否自动提交”轴，二者独立，不能互相推断。

## Decision Tree Protocol

用于复杂规划、mission、architecture/design 或用户要求 grill/决策树时。推荐落盘：

```text
analysis/decision-tree.md
```

最小结构：

```markdown
# Decision Tree

## Root Question
- 本次规划最核心的不确定性是什么？

## Severity
- mode: light
- max_rounds:
- max_questions_per_round:

## Decision Frontier
| ID | Question | Priority | Blocks | Answerable By | Evidence | Recommendation | Status |
|----|----------|----------|--------|---------------|----------|----------------|--------|
| D1 |          | P0       |        | code/docs/user/tradeoff | | | pending |

## Assumptions
- 
```

提问规则：

- 先列出决策树，再选择当前 **decision frontier**：最阻塞下游产物、且无法从代码/文档查证的 P0/P1 节点。
- 每个问题必须包含：为什么现在问、阻塞哪些产物、推荐答案、2-3 个选项、无回复时默认值。
- 一轮内只问互不依赖的问题；依赖型问题必须等父问题 resolved 后再问。
- 收到答复后，回写 `decisions.md` 的“用户答复 / 最终决策 / 决策理由 / 状态”，并更新 `analysis/decision-tree.md`。

`decisions.md` 推荐字段扩展：

```markdown
- Parent:
- Blocks:
- Evidence:
- Confidence: 0.0-1.0
- Reversibility: easy | moderate | hard
- Durable candidate: yes | no
```

## 协议

### ask-single-question-free
单个开放式问题，自由文本作答。用于：澄清范围、收集一个决策（如 track 创建时的"修改意见"）。

### ask-multi-question-free
一轮内多个开放式问题，自由文本作答。用于：同轮收集多个相关决策（如 track 创建的"修改意见 + 提交模式 + 校验模式 + 方向审查"）。

### ask-single-question-closed
单个封闭式问题，给定选项择一/择多。用于：明确的二选一/多选一（如"是否配置并行参数 A/B"）。

## 与 skill 的衔接

- skill 的 `<ask protocol="ask-single-question-free">…</ask>` 表示该步可能需要交互；执行时按本协议判断"是否真的需要问"。
- 失败处理类提问（重试/跳过/中止）也走对应封闭/开放协议。
- 若当前 severity 为 `auto`，所有 `<ask ...>` 都必须被“写入假设 + 选择保守默认”替代；只有外部系统凭证、无法继续的权限缺失、 destructive 操作授权这类硬阻塞可以停止说明，仍不发规划确认问题。
