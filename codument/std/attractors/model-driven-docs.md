# Modeling / Engineering Knowledge Attractor

## 目的

当 modeling / engineering profile 启用时，本文件是长期结构知识与工程知识的路由入口。

```text
codument/modeling/     # 领域结构真源，XNL registry
codument/engineering/  # 工程知识真源，XNL registry
```

详细规范：

- modeling：`std/spec/modeling-registry.md`、`modeling-node-schema.md`、`modeling-delta.md`。
- engineering：`std/spec/engineering-registry.md`、`engineering-node-schema.md`、`engineering-delta.md`。
- 分形拆分与类目选择：`std/skill/docs-modeling-fractal/index.md`、`docs-engineering-fractal/index.md`。
- 信息晋升与冲突优先级：`std/attractors/knowledge-tiers.md`。

## 真源边界

- `codument/modeling/`：对象、类型、状态机、模块依赖、事实源、actor、policy 等结构真相。
- `codument/engineering/`：实现、维护、运维、参考、示例、排障和 runbook。
- `codument/behaviors/`：可测的对外行为契约。
- 源码、测试、schema、配置：可执行真相。
- `codument/decisions/`：长期承重决策。
- `codument/memory/`：可复用 lessons、incidents、patterns、summaries。

modeling 不复述 behavior case，engineering 不复制 modeling 本体；跨 registry 使用 `modeling://...`、`behavior://...` 等逻辑引用。

## 物理结构

```text
codument/
  modeling/
    <plane>/<context>/index.xnl
    <plane>/<context>/<kind>/<id>.xnl
  engineering/
    <plane>/<category>/index.xnl
    <plane>/<category>/<topic>.xnl
```

规则：

- modeling 必须有 `domain` plane；其他 plane 是 derived projection。
- engineering 推荐有 `global` plane；其他 plane 按实现领域命名。
- 小 registry 可先聚合在 `index.xnl`；超过 lint 阈值后拆为同名 kind/category 子文件。
- 文件由宿主 git 版本化；xnl-vfs/xnl-vcs 只在 `.tmp/` 中充当临时合并引擎。
- 不在 registry 中创建 Markdown `index.md`、frontmatter 或旧 docs 建模目录的兼容副本。

## 元数据与引用

registry 元数据写在 XNL 节点属性中，不使用 Markdown frontmatter：

- modeling 节点至少遵循 `kind`、稳定 `#id` 与该 kind 的最小表征；derived 节点用 `derived_from="modeling://..."`。
- engineering 节点至少遵循 `kind`、稳定 `#id` 与该 kind 的必需 section。
- modeling 引用 behavior 用 `behavior://...`；engineering 引用本体用 `modeling://...`。
- 代码位置写入对应节点正文或 engineering reference/code-map 节点，不把路径数组堆进元数据。

## Track Knowledge Sync

稳定知识通过 track delta 晋升，registry 由 archive 的节点级 3-way merge 统一落盘：

```text
领域结构变化
  -> tracks/active/<id>/modeling_deltas/<plane>/<context>.xnl
  -> codument/modeling/

工程知识变化
  -> tracks/active/<id>/engineering_deltas/<plane>/<category>.xnl
  -> codument/engineering/
```

澄清或实现期一旦知识稳定，当轮就更新对应 delta 并运行校验；归档期负责合并与兜底复查。未稳定猜测留在 track 的 analysis/decisions，不污染 registry。

## Routing Table

| Change Type | Target |
|---|---|
| domain entity / enum / state machine / policy | `modeling_deltas/domain/<context>.xnl` |
| derived route / endpoint / storage projection | `modeling_deltas/<plane>/<context>.xnl` |
| module / component / port / actor 结构 | `modeling_deltas/<plane>/<context>.xnl` |
| 架构总览、实现边界 | `engineering_deltas/global/overview.xnl` 或对应 plane |
| 可重复维护操作 | `engineering_deltas/<plane>/howto.xnl` |
| 实现规则与护栏 | `engineering_deltas/<plane>/rules.xnl` |
| 示例、查表、排障 | 对应 `examples` / `reference` / `troubleshooting` delta |
| 用户可见行为变化 | `behavior_deltas/<capability>/delta.xml` |
| 承重决策 / 复用教训 | `decisions/` / `memory/` |

## Quality Checklist

- [ ] 内容是否属于 modeling 或 engineering，而非 behavior/decision/memory？
- [ ] 是否写入正确的 track delta，而非直接创建旧式 Markdown 文档？
- [ ] XNL 语法、稳定 id、kind 最小表征和逻辑引用是否有效？
- [ ] derived modeling 是否通过 `modeling://...` 指回 canonical 父节点？
- [ ] engineering 是否只写 enforcement/实现知识，不复制 modeling 本体？
- [ ] 已运行 `codument modeling validate --deltas <track-id>` 或 `codument engineering validate --deltas <track-id>`？
