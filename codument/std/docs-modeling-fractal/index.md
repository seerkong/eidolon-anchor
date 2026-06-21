# Modeling 分形标准

> 本标准定义 `docs/modeling/` 的写作方式。它**不是一棵要照抄的固定目录树**，而是一条**递归规则**：同一套"知识节点"规则在每一层复用，每个业务领域用它**长出自己的目录结构**。
>
> 共享内容（节点不变量、frontmatter、根布局、同名文件夹演化、迁移台账、track 同步）见 [model-driven-docs.md](../../attractors/model-driven-docs.md)。本文件只讲 **modeling 侧特有**的约定，不重复共享部分。

## 1. 一句话心法

modeling 树 = 递归的「知识节点」。**不变的是递归规则，可变的是每个领域选的类目词汇。**

- **不变**（所有领域、所有层级都一样）：`plane → context → 类目 → 叶子`；每层 `index.md` 只做导航；一处真源、其余引用；派生处用 `derived_from` 指回来源。
- **可变**（每个领域自己定）：有哪些 plane；每个 context 内部按哪些「类目」切分真源（`objects`？`routes`？`datasets`？`scenes`？）。

> ⚠️ 不要把本文示例里的 `objects / policies / workflows` 当成强制目录名——那只是"软件 domain 平面"的**一种**类目选择，不是分形的一部分。

## 2. Plane 层

路径：`docs/modeling/<plane>/`

- **`domain`（唯一必需 plane）**：canonical 业务本体，不依赖任何 derived plane。
- **derived plane（可选、项目按领域命名）**：把 domain 概念投影到某个建模视角。命名贴合领域，例如 `backend`、`surface`、`runtime`、`api`、`storage`、`pipeline`、`agent`、`tool`、`integration`……
- derived plane 必须在文档 `derived_from` 指回它投影的 domain 真源；**不得复制成第二份真源**。

plane 根固定三件：

```text
docs/modeling/<plane>/
  index.md          # 只导航：列本 plane 的 contexts，声明 canonical / derived
  glossary.md       # 本 plane 术语；domain 术语是 canonical，derived 术语指回 domain term
  contexts/index.md # context 入口表
```

## 3. Context 层 —— 类目由领域决定（本标准核心）

context 是 plane 内的边界单元：`docs/modeling/<plane>/contexts/<context>/`

每个 context **固定只有两件事**：

```text
index.md      # 边界（Boundary / Not Owned Here）+ 导航到各类目
code-map.md   # 把本 context 的建模知识连到源码 / 测试
```

**其余子目录是「类目」，由该 plane 的建模视角决定，不是固定三件套。**

> 类目 = "这个 context 的真源天然按什么维度切分"。给 AI 的规则只有一条：
>
> **选 3–6 个正交、稳定、领域自然的类目作为 context 第一层子目录；每个类目下再放叶子 `.md`，太大再升级同名文件夹。**

### 三个真实示例（证明类目随领域而变，不固定 web）

```text
# domain 平面（DDD 本体）—— 概念真源
contexts/<ctx>/{ objects/  policies/  workflows/ }
                  对象       跨对象规则   多步流程

# backend 平面（后端投影）—— 服务端真源
contexts/<ctx>/{ routes  dto_maps  errors  contracts  storage  read-models  sync-flows }

# surface 平面（前端投影）—— 前端真源
contexts/<ctx>/{ routes  actions  ui-state  read-models  sync-flows }
```

换一个**非软件 / 非 web** 领域，类目会完全不同：

```text
数据管道领域：  sources/   transforms/  sinks/      schedules/
游戏领域：      entities/  systems/     scenes/     rules/
ML 领域：       datasets/  features/    models/     experiments/
```

→ 关键动作：**先问"本领域这个 context 的真源天然分成哪几类"，再建目录**；不要硬套别人的类目名。

### Context `index.md`（小模板）

```markdown
---
knowledge_plane: <plane>
doc_role: guide
status: active
context: <context>
derived_from: docs/modeling/domain/contexts/<context>/index.md   # 仅 derived plane
last_verified: YYYY-MM-DD
---

# <Context> Context

> 目录职责 · holds: <本 context 的真源边界> · excludes: <去哪> · tier: stable · ⬆from: track design 稳定后 · ⬇to: 代码/测试

## Boundary
本 context 拥有……

## Not Owned Here   # 与相邻 context 易混时必写
- ……

| 类目 | 职责 | 何时阅读 |
|------|------|----------|
| <category>/index.md | …… | …… |

## Code Map
- code-map.md
```

规则：domain context 省略 `derived_from`；derived context 与 domain context 对齐时填**单一**父来源。`Boundary` 必写。index 只导航 + 说边界，不承载真源。**每个文件夹的 `index.md` 顶部带「目录职责」块**（标准类目用一行精简型，自定义类目用完整型）——格式与补齐见 [folder-manifest.md](@codument/std/spec/folder-manifest.md)。

### 叶子文件

- domain 的 `objects/` 习惯把每个 object 拆成 `data.md`（结构语义）+ `behavior.md`（行为语义）；其他类目通常单文件，太大再升级同名文件夹。
- 每个叶子**讲语义，不机械罗列字段**。

```markdown
# Bad
- status: string
- owner_id: number

# Good
- `status`：生命周期标记。`draft` 可编辑；`published` 对外可见。
- `owner_id`：归属边界，用于访问校验与唯一性范围。
```

## 4. 叶子写作要点（按类目选自然小节，不强制统一模板）

不同类目用不同小节即可——下面是**小节清单**，不是目录：

| 真源类型 | 建议小节 |
|----------|----------|
| 结构型（object/data/storage） | Identity & Boundary · Structure · Field Semantics（按语义分组）· Relationships · States · Invariants · Compatibility |
| 行为型（behavior/workflow/sync-flow） | Trigger / Messages · Preconditions & Guards · State Transitions · Side Effects · Failure Semantics · Idempotency & Concurrency |
| 规则型（policy/rule） | Rule · Scope · Rationale · Enforcement Points · Exceptions · Failure Semantics |

跨 object 的 guard 放 policy 类目；单 object 消息链接到该 object 的 behavior。derived 叶子引用 canonical，只描述投影差异，不重写正文。

## 5. Frontmatter（用受控精简 schema）

字段集与含义在 [model-driven-docs.md](../../attractors/model-driven-docs.md) 统一定义。modeling 侧附加约定：

- `context:` 必填。
- `derived_from:` **只写一个**最近的 canonical 父来源（一行）。**不要堆十几行来源清单**——长来源关系写正文或 `code-map.md`。
- 代码路径**不进** frontmatter，写 `code-map.md` 或正文。

## 6. 在你自己的领域长出一个新 modeling plane（生成式步骤）

1. **定性**：它是 canonical（只有 `domain`）还是 derived？derived 就确定它投影自哪些 domain 真源。
2. **列 context**：通常与 domain context 对齐、同名；没有投影的可省略，不要为对称伪造。
3. **定类目**：对每个 context 问"真源天然分成哪几类"→ 选 3–6 个正交类目（这一步就是把领域知识落成目录）。
4. **起骨架**：建 `index.md`(导航) + `code-map.md` + 各类目目录；叶子先用单文件。**每个类目目录给其 `index.md` 写「目录职责」块**（自定义类目必填，见 [folder-manifest.md](@codument/std/spec/folder-manifest.md)）。
5. **连真源**：derived 文档填 `derived_from`（单一父），不复制 canonical。

## 7. 反模式

- ❌ context 第一层把"主题"和"类目"混在一起 → 第一层只放类目，类目下再放主题/叶子。
- ❌ 复制 canonical domain 真源形成第二份真源 → derived 引用 + 只写投影差异。
- ❌ 为了和 domain 对称，伪造该 plane 并不存在的 derived 概念。
- ❌ `index.md` 承载真源 → index 只导航与边界。
- ❌ `derived_from` 堆成长清单 → 单一父来源；其余关系写正文。
- ❌ 硬把别的领域的 `objects/policies/workflows` 套到不适配的 plane → 类目由本领域真源结构决定。
