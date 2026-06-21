# skill: codument-docs-bootstrap（把现存项目总结进分形 docs）

**本提示词供执行文档建模引导的代理阅读。** 当前任务是读取现存项目事实，按 Codument docs 分形规范一次性建立或更新 `docs/modeling/` 与 `docs/impl/`，并记录不确定项，为后续 knowledge sync 打底。

> 本文是完整协议（口径已对齐当前标准）。**程序化的执行流程**（inventory→write-modeling→write-impl→backfill-manifests→record-uncertainty 序列）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 `codument/std/operations/_operation-spec.md`）表达；**说明、规则、背景、示例**用 Markdown，内嵌 XML/YAML 用围栏。
>
> 口径映射：`codument:docs-bootstrap`→`codument-docs-bootstrap`；`codument/specs/`→`codument/behaviors/`；分形规范路径**修正**为 `codument/std/docs-modeling-fractal/index.md` 与 `codument/std/docs-impl-fractal/index.md`（**不是** `attractors/docs-*-fractal`）。

---

## 0. 总纲

你是 Codument 文档建模代理。当前任务是按 Codument docs 分形规范建立或更新：

- **`docs/modeling/`**：领域本体——领域模型、能力边界、用户/系统行为、约束、状态机、术语、业务规则、与实现无关的外部契约。**领域中立**——类目词汇由本领域真源结构决定，**不写死 web / surface / backend 这类结构**。
- **`docs/impl/`**：实现知识——目录与模块职责、入口/命令/API/任务流、数据流与持久化、配置/运行/测试/构建、关键实现决策与已知限制。

铁律：**不要把猜测写成事实**。不确定信息必须写入待确认事项（uncertainty / TODO）。

本 skill 是**普通文档整理流程**，不需要 gap-loop 式 fresh child orchestration；只有用户显式要求并行审查时才考虑委派子代理（见 `codument/std/operations/gap-loop.md`）。

**入参**（可选）：`scope`——要总结的子系统 / 目录；缺省全项目。

### 与 docs profile 的关系

- **bootstrap 建立 docs 体系**：这是**一次性引导**，把现状落成分形 docs 的起点。
- 之后 **track 归档时由 `artifact-sync` 做增量同步**（docs profile enabled + 显式 hook，见 `codument/std/operations/artifact-sync.md`）。
- 即便 docs profile 未启用，本 skill 也可**纯手动跑**。

---

## 1. 输入读取顺序

1. 读取 `codument/attractors/`；旧项目可兼容读取 `codument/project.md`、`codument/product.md`、`codument/tech-stack.md`。
2. 读取 `codument/config/attractor-profiles.xml`，确认 `docs` profile 是否启用；**即使未启用，本 skill 仍可手动执行**。
3. 读取现有 `docs/modeling`、`docs/impl` 与其他 docs 目录。
4. 读取 README、package/config、入口文件、核心源码目录、测试目录、CLI/API 路由或集成点。
5. 读取 `codument/behaviors/` 与近期重要 archive/track，**只把能从事实支持的内容写入 docs**。

---

## 2. 写入规则

### 2.1 docs/modeling（稳定知识，领域中立）

写入：领域模型与术语、capability 边界、用户目标与系统行为、约束/状态机/业务规则、与实现无关的外部契约。

按 modeling 分形规范落盘（`codument/std/docs-modeling-fractal/index.md`）：

- 递归规则不变：`plane → context → 类目 → 叶子`；每层 `index.md` 只导航；一处真源、其余引用；derived 用 `derived_from` 指回 canonical。
- **类目词汇随领域变**：先问"本领域这个 context 的真源天然分成哪几类"，选 3–6 个正交、稳定、领域自然的类目作为 context 第一层子目录——**不要硬套别人的 `objects/policies/workflows` 或写死 web 结构**。
- 必需 plane：`domain`（canonical 本体）；derived plane 按领域命名（`backend`/`surface`/`runtime`/`pipeline`/…）。

### 2.2 docs/impl（实现知识）

写入：目录与模块职责、入口/命令/API/任务流、数据流与持久化、配置/运行/测试/构建、关键实现决策与已知限制。

按 impl 分形规范落盘（`codument/std/docs-impl-fractal/index.md`）：

- 递归规则同构：`plane → 类目 → 主题 → 叶子`；类目在前、主题在后；本体不放这里，引用 `docs/modeling/`。
- 推荐默认六类作为起点：`overview / howto / rules / examples / reference / troubleshooting`；领域不适配时在 plane 第一层换成领域自定义类目集。
- 推荐 plane：`global`（跨 plane 实现知识）；其余按领域命名。

### 2.3 文件组织

- 优先创建**少量可导航文件**；单文件过长时升级为同名目录 + `index.md`。
- `index.md` 只做导航与摘要，不塞大量正文。
- **不覆盖用户已有手写内容**；需要重写时保留可追溯摘要。

**最小可用 bootstrap**：若项目还没有 `docs/modeling` 和 `docs/impl`，可先创建两个轻量入口 `docs/modeling/index.md`、`docs/impl/index.md`，先承载事实来源、核心摘要、待确认项与后续拆分计划；一旦正文过长，再把具体主题拆到同名子文件，让 `index.md` 回到导航职责。

---

## 3. 目录职责块（folder-manifest）

对建出的**每个目录**，按 `codument/std/spec/folder-manifest.md` 在其 `index.md` 的 H1 下方写一个**目录职责块**：

- **标准文件夹**（分形默认类目）：可继承分形默认，写一行**精简型**：

  ```markdown
  > 目录职责 · holds: <装什么> · excludes: <不装什么/去向> · tier: stable|dated · ⬆from: <晋升来源> · ⬇to: <晋升去向>
  ```

- **自定义文件夹**（本领域自己长出的类目，分形规范无法预知）：**必须**写**完整型**职责块：

  ```markdown
  ## 目录职责
  - **holds**：……
  - **excludes**：……（去向）
  - **tier**：`stable` | `dated`
  - **promotes_from**：上游来源层
  - **promotes_to**：下游去向层
  ```

字段语义（`holds`/`excludes`/`tier`/`promotes_from`/`promotes_to`）与 tier/晋升语义对齐 `codument/attractors/knowledge-tiers.md`。

**补齐（backfill）**：扫描 `docs/` 下每个含 `index.md` 的目录，对**缺职责块**或**自定义目录无完整型块**的补上——从目录名+树中位置套分形默认语义、从实际内容收敛 holds/excludes、从 knowledge-tiers 定 tier 与晋升边；推断不确定时**标 TODO/uncertainty，不臆造**，自定义目录语义模糊时提请人工确认。补齐**幂等**：只补缺失，不覆盖人工已写的块（除非显式确认）。

---

## 4. 执行流程

```text
@delimiter: --
-- #sequence ?bootstrap
---- #step ?inventory
盘点：按 §1 顺序读 attractors / config / 现有 docs / README+源码+测试+路由 / behaviors+近期 track；列出事实来源与已有 docs 状态；决定哪些知识进 modeling、哪些进 impl
---- /?inventory
---- #step ?write-modeling
按 modeling 分形规范把领域/本体（概念、关系、能力本体、约束、术语）落盘到 docs/modeling/...（领域中立，类目由真源结构决定，不写死 web）；derived 填 derived_from 不复制 canonical
---- /?write-modeling
---- #step ?write-impl
按 impl 分形规范把实现知识（模块、接口、关键流程、运维）落盘到 docs/impl/...（类目在前主题在后，默认六类或领域自定义）；本体引用 docs/modeling，不复制
---- /?write-impl
---- #step ?backfill-manifests
对建出的每个目录按 folder-manifest 给其 index.md 写「目录职责」块（标准类目精简型 / 自定义类目完整型）；扫描缺块的幂等补齐，不覆盖人工块
---- /?backfill-manifests
---- #step ?record-uncertainty
对推断不确定处显式标注 TODO/uncertainty，不臆造；docs profile 关闭时本步仍可纯手动执行
---- /?record-uncertainty
---- #step ?review-report
Review：检查猜测/重复/过度拆分/实现与建模混写；Report：列出更新的文件、未写入原因、待确认问题
---- /?review-report
-- /?bootstrap
```

---

## 5. 验证

- 文档中的事实必须能**追溯**到源码、测试、behavior、track、archive、README 或 attractor。
- `docs/modeling` **不应**写实现目录细节。
- `docs/impl` **不应**替代领域/behavior 真源（本体引用 `docs/modeling`，不复制）。
- 每个建出的目录其 `index.md` 都有合法的目录职责块（自定义类目为完整型）。
- 如项目无测试或入口不明确，记录为待确认，**不阻塞**已有事实整理。

## 输出

`docs/modeling/**` 与 `docs/impl/**`（含各目录的目录职责块）+ 待确认/不确定项清单。

## 引用

- modeling 分形规范：`codument/std/docs-modeling-fractal/index.md`
- impl 分形规范：`codument/std/docs-impl-fractal/index.md`
- 目录职责块格式与补齐：`codument/std/spec/folder-manifest.md`
- 知识分层 / 晋升 / 真源优先级：`codument/attractors/knowledge-tiers.md`
- 归档期增量 docs 同步：`codument/std/operations/artifact-sync.md`
- 流程标记块语法：`codument/std/operations/_operation-spec.md`
