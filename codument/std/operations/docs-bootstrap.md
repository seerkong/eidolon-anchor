# skill: codument-docs-bootstrap（把现存项目总结进 modeling / engineering registries）

**本提示词供执行知识建模引导的代理阅读。** 当前任务是读取现存项目事实，按 Codument XNL registry 规范一次性建立或更新 `codument/modeling/` 与 `codument/engineering/`，并记录不确定项，为后续 knowledge sync 打底。

> 程序化流程使用 ` ```text ` + `@delimiter: --` 的流程标记块；registry 内容使用当前 XNL 规范。

---

## 0. 总纲

你是 Codument 文档建模代理。当前任务是按 Codument docs 分形规范建立或更新：

- **`codument/modeling/`**：领域本体——领域模型、能力边界、用户/系统行为、约束、状态机、术语、业务规则、与实现无关的外部契约。**领域中立**——类目词汇由本领域真源结构决定，**不写死 web / surface / backend 这类结构**。
- **`codument/engineering/`**：实现知识——目录与模块职责、入口/命令/API/任务流、数据流与持久化、配置/运行/测试/构建、关键实现决策与已知限制。

铁律：**不要把猜测写成事实**。不确定信息必须写入待确认事项（uncertainty / TODO）。

本 skill 是**普通 registry 引导流程**，不需要 gap-loop 式 fresh child orchestration；只有用户显式要求并行审查时才考虑委派子代理（见 `codument/std/operations/gap-loop.md`）。

**入参**（可选）：`scope`——要总结的子系统 / 目录；缺省全项目。

### 与 docs profile 的关系

- **bootstrap 建立 docs 体系**：这是**一次性引导**，把现状落成分形 docs 的起点。
- 之后 Track 的 modeling/engineering delta 由 `codument archive` registry transaction 晋升。`artifact-sync` 只分发显式指定的外部文档制品树，不维护这两个 registry。
- 即便 docs profile 未启用，本 skill 也可**纯手动跑**。

---

## 1. 输入读取顺序

1. 读取 `codument/attractors/`。
2. 读取 `codument/config/attractor-profiles.xnl`，确认 `docs` profile 是否启用；**即使未启用，本 skill 仍可手动执行**。
3. 读取现有 `codument/modeling`、`codument/engineering` 与其他 docs 目录。
4. 读取 README、package/config、入口文件、核心源码目录、测试目录、CLI/API 路由或集成点。
5. 读取 `codument/behaviors/` 与近期重要 archive/track，**只把能从事实支持的内容写入 docs**。

---

## 2. 写入规则

### 2.1 codument/modeling（稳定知识，领域中立）

写入：领域模型与术语、capability 边界、用户目标与系统行为、约束/状态机/业务规则、与实现无关的外部契约。

按 modeling 分形规范落盘（`codument/std/skill/docs-modeling-fractal/index.md`）：

- 递归规则不变：`plane → context → 节点`；小 context 聚合在 `index.xnl`，超过 lint 阈值后按 kind / 稳定主题拆分。
- 节点 kind 与最小表征遵循 `modeling-node-schema.md`；derived 在属性块写 `{ derived_from = "modeling://..." }` 指回 canonical。
- 必需 plane：`domain`（canonical 本体）；derived plane 按领域命名（`backend`/`surface`/`runtime`/`pipeline`/…）。

### 2.2 codument/engineering（实现知识）

写入：目录与模块职责、入口/命令/API/任务流、数据流与持久化、配置/运行/测试/构建、关键实现决策与已知限制。

按 engineering 分形规范落盘（`codument/std/skill/docs-engineering-fractal/index.md`）：

- 递归规则：`plane → 类目 → 主题节点`；小类目聚合在 `index.xnl`，超过 lint 阈值后拆分；本体不放这里，使用 `modeling://...` 引用。
- 推荐默认六类作为起点：`overview / howto / rules / examples / reference / troubleshooting`；领域不适配时在 plane 第一层换成领域自定义类目集。
- 推荐 plane：`global`（跨 plane 实现知识）；其余按领域命名。

### 2.3 Registry 组织

- 优先创建**少量可导航的 XNL 文件**；先写 `index.xnl`，文件过大时再按稳定节点拆分。
- 保持稳定 `#id` 与逻辑 URI；物理拆分不能改变引用。
- **不覆盖用户已有手写内容**；需要重写时保留可追溯摘要。

**最小可用 bootstrap**：若 registry 尚不存在，先创建 `codument/modeling/domain/<context>/index.xnl` 与 `codument/engineering/global/overview/index.xnl`，只写有证据支持的最小节点；内容增长后再按 lint 建议拆分。

---

## 3. Registry 校验

- modeling 写完运行 `codument modeling validate` 与 `codument modeling lint`。
- engineering 写完运行 `codument engineering validate` 与 `codument engineering lint`。
- 如果通过 track delta 引导 bootstrap，则使用对应的 `--deltas <track-id>` 校验方式。
- 校验失败时修正 XNL 语法、路径与 id 对齐、kind 最小表征或悬空逻辑引用；不要用 Markdown 兼容文件绕过校验。

---

## 4. 执行流程

```text
@delimiter: --
-- #sequence ?bootstrap
---- #step ?inventory
盘点：按 §1 顺序读 attractors / config / 现有 docs / README+源码+测试+路由 / behaviors+近期 track；列出事实来源与已有 docs 状态；决定哪些知识进 modeling、哪些进 engineering
---- /?inventory
---- #step ?write-modeling
按 modeling 分形规范把领域/本体（概念、关系、能力本体、约束、术语）落盘到 codument/modeling/...（领域中立，类目由真源结构决定，不写死 web）；derived 填 derived_from 不复制 canonical
---- /?write-modeling
---- #step ?write-engineering
按 engineering 分形规范把实现知识（模块、接口、关键流程、运维）落盘到 codument/engineering/...（类目在前主题在后，默认六类或领域自定义）；本体引用 codument/modeling，不复制
---- /?write-engineering
---- #step ?validate-registries
运行 modeling / engineering validate 与 lint；修正 XNL 语法、schema、路径-id 对齐和引用问题
---- /?validate-registries
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
- `codument/modeling` **不应**写实现目录细节。
- `codument/engineering` **不应**替代领域/behavior 真源（本体引用 `codument/modeling`，不复制）。
- 两个 registry 均通过对应 validate；lint 结果已处理或明确记录拆分建议。
- 如项目无测试或入口不明确，记录为待确认，**不阻塞**已有事实整理。

## 输出

`codument/modeling/**/*.xnl` 与 `codument/engineering/**/*.xnl` + 待确认/不确定项清单。

## 引用

- modeling 分形规范：`codument/std/skill/docs-modeling-fractal/index.md`
- engineering 分形规范：`codument/std/skill/docs-engineering-fractal/index.md`
- modeling / engineering registry 与节点 schema：`codument/std/spec/{modeling,engineering}-{registry,node-schema}.md`
- 知识分层 / 晋升 / 真源优先级：`codument/std/attractors/knowledge-tiers.md`
- Track registry 晋升：`codument/std/operations/archive-track.md`
- 外部文档制品分发：`codument/std/operations/artifact-sync.md`
- 流程标记块语法：`codument/std/operations/_operation-spec.md`
