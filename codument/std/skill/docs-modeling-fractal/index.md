# Modeling 分形标准

> 本标准定义 `codument/modeling/` XNL registry 的分形拆分方式。节点 schema 以 `std/spec/modeling-node-schema.md` 为准，registry 与 delta 协议以 `std/spec/modeling-{registry,delta}.md` 为准。

## 一句话心法

modeling registry = `plane → context → 节点`。小 context 聚合在 `index.xnl`，超过 lint 阈值后按 kind / 稳定主题拆文件；逻辑引用始终指向节点 URI，不依赖物理文件路径。

## Plane 与 Context

```text
codument/modeling/
  domain/                     # 必需，canonical
    <context>/index.xnl
    <context>/<kind>/<id>.xnl
  <derived-plane>/            # 可选，如 backend/surface/runtime/storage
    <context>/index.xnl
```

- `domain` 是唯一 canonical plane。
- derived plane 只描述投影差异，并用 `derived_from="modeling://domain/<context>/<id>"` 指回最近的 canonical 父节点。
- context 是 plane 内的边界单元；节点通过 `<not-owned-here ?>... </?>` 或等价描述明确相邻边界。
- 不创建 Markdown `index.md`、frontmatter、glossary 目录树或旧 docs 建模目录的兼容副本。

## 节点与类目

类目由节点 `kind` 表达，不靠固定 Markdown 目录：

- 内核 kind：`entity`、`enum`、`state-machine`、`module`、`component`、`port`、`actor`、`policy`。
- shell kind：使用命名空间值，如 `surface:route`、`backend:endpoint`、`cli:command`。
- shell kind 放在普通 XNL 标签的 `kind` 属性中，不能把冒号写进元素标签名。

同一 context 的节点较少时写入 `<plane>/<context>/index.xnl`；节点较多时可拆为 `<plane>/<context>/<kind>/<id>.xnl`。拆分不改变稳定 `#id` 或 `modeling://...` 引用。

## 表征与引用

- 每个节点都有稳定 `#<context>.<name>` 或 `#<plane>.<context>.<name>`。
- 按 kind 提供必需的 `types`、`mermaid`、`pseudo`、runtime/input/config/output 等表征。
- modeling 引用 behavior 用 `behavior://...`，引用其他 modeling 节点用 `modeling://...`。
- 可测行为留在 `codument/behaviors/`；modeling 只保存结构、语义和约束。
- 描述性内容用中文，代码标识符、kind、枚举、字段名、`#id` 和 URI 保持英文。

## Track 写入

进行中的 track 不直接修改 registry：

```text
tracks/{pending,active}/<id>/modeling_deltas/<plane>/<context>.xnl
```

delta 表达目标态节点；archive 使用宿主 git base + 当前 registry + delta 做节点级 3-way merge，再写回 `codument/modeling/`。

## 验证

```bash
codument modeling validate --deltas <track-id>
codument modeling lint
```

反模式：

- 把 behavior case 复制成 modeling 节点。
- 在 `codument/modeling/` 下写 Markdown/frontmatter。
- derived 节点复制 canonical 正文而不写 `derived_from`。
- 用文件路径代替 `modeling://...` 节点引用。
- 为了目录对称伪造没有结构意义的 plane、context 或 kind。
