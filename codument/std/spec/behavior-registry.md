# Behavior 登记表规范

`codument/behaviors/` 是项目行为契约的合并真源。新 authority 使用 Halfcode-backed XNL；track 完成归档时把 `behavior_deltas/` 应用进来。

## 布局

```
codument/behaviors/
├── <capability>.xnl              当前单文件 authority
└── <capability>/                 legacy folder/include 兼容布局
    ├── index.xml
    └── <area>.xml
```

- 新建与单文件写回只使用 `<capability>.xnl`。legacy folder/include XML 在迁移窗口内可继续读写；不得同时存在同 capability 的 `.xnl` 与 `.xml`。
- 当前 Kind 版本尚未定义跨文件 XNL assembly，因此不得把大型 capability 静默拆成无法装配的 XNL 片段。文件过大时优先按稳定业务边界拆成独立 sub-capability registry；如果旧 folder/include 结构无法无损映射，`upgrade-resource` 必须返回 `review-required` 并保留原 authority，等待 Halfcode 多文件 Kind assembly 有明确契约后再迁移。
- `behavior://<capability>/requirements/<id>/suites/<id>/cases/<id>` 是定位行为节点的 VFS 路径，被 `behavior-patch` 的 `selector` 与跨文档引用使用；可按节点层级截短，例如只定位到 `requirements/<id>`。

## 节点

下例是 archive transaction 依据当前 Behavior Kind 写出的 registry 投影；根 `#id`、`apiVersion` 与 `version` 由 CLI 维护，不能从示例手写或复制。

```xnl
<Behavior #csv-export apiVersion="codument.tech/v1alpha1" version="1" (
  <Requirements [
    <Requirement #export-endpoint (
      <Statement ?>系统 SHALL 提供 GET /reports/export.csv。</?>
      <Suites [
        <Suite #csv-export (
          <Cases [
            <Case #escapes-fields (
              <Given ?>字段包含分隔符。</?>
              <When ?>导出 CSV。</?>
              <Then ?>字段按 RFC 4180 转义。</?>
            )>
          ]>
        )>
      ]>
    )>
  ]>
)>
```

- `Behavior #capability` 是 identity；`apiVersion`/`version` 在 metadata，普通属性放 `{}`。
- `Requirements`、`Suites`、`Cases` 与重复 `Ands` 是 `[]` collection；单个 `Statement/Given/When/Then` 放 `()`。
- `Requirement`、`Suite`、`Case` 可带一个 singleton `<KnowledgeHint { target = "docs-profile" href = "vfs://..." strength = "hint" }>`。这是指向 modeling/engineering profile 的弱关联，不是 behavior authority 的依赖边；`target` 必须为 `docs-profile`，`href` 必须使用 `vfs://`。链接暂不可解析时只给 warning，不阻断 merge 或 archive。
- 行为本体是事实真源，不复述实现细节（实现真源在代码 + `codument/engineering`）。

## 应用 delta（归档时）

1. 解析当前 apiVersion 的 `behavior_deltas/<cap>/delta.xnl` `<BehaviorPatch>`；legacy XML 只作兼容和迁移输入。
2. 对 `<Mutations []>` 中每个 `Upsert|Delete|Move` 的 `behavior://` selector 定位并施改。
3. 登记表内容变化后，若启用 docs 同步，按显式 hook 联动 docs（见 `std/operations/artifact-sync.md`）。

## 设计取舍

- Behavior 登记表是契约层（“系统应有什么行为”），不与代码或文档争夺实现真源。
