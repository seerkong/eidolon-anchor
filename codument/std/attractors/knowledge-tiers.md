# Knowledge Tiers & 信息晋升（std/attractors/knowledge-tiers.md）

> codument 的**知识分层地图 + 信息晋升阶梯 + 真源优先级**。它回答三个问题：
> 1. 一条信息该落到哪个目录（**分层与职责**）；
> 2. 它什么时候、怎样从临时记录**晋升**为长期真源（**晋升阶梯**）；
> 3. 事实冲突时谁说了算（**真源优先级**）。
>
> 借鉴 attractor-guided-engineering 的"目录职责 + 源真优先级 + 信息晋升"纪律，按 codument 的 **track 中心**模型重构。具体文件级目录规范见 [model-driven-docs.md](./model-driven-docs.md) 与 [std/spec/folder-manifest.md](@codument/std/spec/folder-manifest.md)。

## 1. 心法：attractor / carrier / projection 三层

- **attractor（吸引子本身）**：少量高层不变量——领域如何划界、行为契约、结构关系。
- **carrier（吸引子的载体）**：把不变量外化成可版本化、可审计的文档——即 `attractors/` + `codument/modeling/` + `codument/engineering/` + `behaviors/` + `decisions/`。**长期 owner 文档 = 吸引子的载体。**
- **projection（瞬时投影）**：当前代码/测试——吸引子的瞬时实现。

> 推论：chat 是临时上下文，**文件才是仓库记忆**。重要输入先落文件再 `@`；重要结论按职责分类写回，而不是留在对话里。track 是一次迭代的轨迹；轨迹中稳定下来的真理必须**收敛**进 owner 文档。

## 2. 知识分层表

| 层 | 目录 | 装什么 | 时效 | 是谁的真源 |
|---|---|---|---|---|
| 结构不变量 | `attractors/` | project/product 吸引子、本表、docs 规范 | 稳定·就地改 | 高层不变量、知识纪律 |
| 领域本体 | `codument/modeling/` | canonical + derived 建模真源 | 稳定·就地改 | "当前领域本体是什么" |
| 实现/运维 | `codument/engineering/` | 架构、howto、规则、参考、排障 | 稳定·就地改 | "实现与维护怎么做" |
| 能力契约 | `behaviors/`（`codument/behaviors/`） | 行为登记表（行为 case、测试生成依据） | 稳定·就地改 | "系统对外承诺什么行为" |
| 承重决策 | `decisions/`（`decision://`） | 从 track 提升的长期决策 | 稳定·追加 | "为什么这么定" |
| 长期教训 | `memory/`（`memory://`） | lessons / incidents / patterns / summaries | 稳定·追加 | "反复踩的坑 / 复用模式" |
| 候选工作 | `backlog/` | 跨 track 的下一步候选 + 自主度 | 活的·就地改 | "下一个该做什么"（非真源） |
| 跨 track 路线 | `missions/<id>/roadmap.md` | 一组相关 track 的阶段路线、依赖、进度证据 | 活的·就地改 | "多个 track 如何排布"（非行为真源） |
| 迭代工作面 | `tracks/{pending,active}/<id>/` | proposal、design、discussion、`track.xml`、`behavior_deltas/`、`analysis/`、`decisions*`、`reports/` | **带日期·迭代内可变** | "本次要建什么 / 怎么收口 / 发生了什么" |
| 轨迹历史 | `tracks/archived/YYYY-MM/...` | 已完成 track | **带日期·归档后不可变** | "历史上做过什么" |

> 工具性目录（`std/`、`config/`、`workflows/`、`sop/`）不是知识层，不在晋升阶梯内。

## 3. 信息晋升阶梯（核心）

信息从"临时"走向"长期"的固定路径。每一跳都有**触发条件**——满足才晋升，避免把临时噪音沉淀成真源，也避免让真理烂在 chat / track 里。

```text
外部输入 / 对话
   │  [建 track / discuss 时，落文件]
   ▼
tracks/{pending,active}/<id>/ ── proposal.md · design.md · discussion · behavior_deltas/ · track.xml · reports/
   │
   ├─[行为变更]──────────────▶ behaviors/      （归档必做：delta 应用进登记表）
   │
   ├─[稳定领域知识]──────────▶ codument/modeling/ + codument/engineering/   ★ 要补强的弱环
   │     触发：需求澄清后概念/对象/字段语义/生命周期/policy/workflow/架构已稳定
   │     时机：discuss 期即可**实时**更新（不必等归档）；归档时兜底补齐
   │
   ├─[承重的一次性决策]──────▶ decisions/      （decision://）
   │
   └─[可复用教训 / gap 模式]──▶ memory/         （lessons/incidents/patterns）
         │
         └─[同类问题跨多 track 复发]──▶ 方法层：std/methods/ · std/actions/ · attractor-profile check · action-hook · validation 守卫
               （codument 版 "prose 教训 → 可复用方法 → 固化检查"；先 sop/prompt，再考虑固化为 check/hook）
```

## 4. 何时晋升（触发条件表）

| 从 → 到 | 触发 |
|---|---|
| track → `codument/modeling`/`codument/engineering` | 需求澄清后某概念/行为/policy/workflow/架构**稳定**，将成为后续迭代依赖的基线 → 收敛进 owner 文档，**不要只留在 proposal** |
| track → `behaviors/` | 任何对外行为新增/变更（归档必做） |
| track → `decisions/` | 一个原本一次性的取舍变成"以后都按这个来"的承重决策 |
| track/复盘 → `memory/` | 出现可复用的教训、非显然的 incident、值得记住的 pattern |
| `memory/` → 方法层(sop/skill/check) | **同一类问题反复出现**：先提炼为可复用 sop/prompt；若仍复发，再固化为 attractor-check profile / action-hook / validation 守卫（按项目误报容忍度调优） |
| 任意 → `migration-map` | owner 文档路径移动/拆分/合并/被吸收 |

> 反向**不**晋升：被否决的方案、未稳定的猜测、纯过程噪音留在 track / `memory` 即可，不污染 owner 文档。

## 5. 真源优先级（冲突时谁赢）

| 问题 | 主真源 |
|---|---|
| 当前领域本体是什么 | `codument/modeling/`（canonical）；能力契约看 `behaviors/` |
| 可执行真相（数据/接口/schema） | 源码 / 测试 / schema / config（owner 文档只解释意图） |
| 本次 track 要建什么 | `tracks/pending/<id>/proposal.md` + `behavior_deltas/` |
| 本 track 怎么执行/收口 | `tracks/active/<id>/track.xml` |
| 实现/运维怎么做 | `codument/engineering/` |
| 发生了什么 | `tracks/active/<id>/reports/` + `tracks/archived/` |
| 长期必须为真 | `codument/modeling/` + `codument/engineering/` + `behaviors/` + `decisions/` + `attractors/` |

**冲突裁决**：可执行真源（源码/测试/schema）> owner 文档（需重新校验后才是吸引子）> track 局部 > chat。若解冲突会改变用户可见行为 / 数据形状 / 接口 / 权限 / 外部集成 → **停下确认**，并把冲突归类为 `实现漂移 | 文档漂移 | 有意的遗留行为` 写进 track 再动。

## 6. 时效性

- **稳定 owner 层**（attractors / codument/modeling / codument/engineering / behaviors / decisions）：通过对应 delta 与归档合并维护，不因内容变化就新建带日期副本；registry 元数据与节点 schema 见 model-driven-docs.md 路由。
- **迭代/轨迹层**（tracks/pending、tracks/active、tracks/archived / reports）：带日期；归档后不可变。
- **新鲜度模式**：owner 文档标 `stale|unknown` 时，进入研究/对齐优先——不直接拿可执行真相去"修"文档、也不拿陈旧文档去"改"代码，先把漂移归类记录。

## 7. 路由

- registry 规范（modeling/engineering 怎么写、拆分与校验）：[model-driven-docs.md](./model-driven-docs.md) → [docs-modeling-fractal](@codument/std/skill/docs-modeling-fractal/index.md) / [docs-engineering-fractal](@codument/std/skill/docs-engineering-fractal/index.md)。
- 每个标准文件夹"装什么"的自描述与补齐：[std/spec/folder-manifest.md](@codument/std/spec/folder-manifest.md)。
- 晋升动作落在流程里：归档晋升见 `std/actions/archive-track.md`；docs 同步见 `std/actions/artifact-sync.md`；澄清期实时更新见 `std/protocols/questioning.md`。
