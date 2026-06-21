# behavior 登记表规范（std/spec/behavior-registry.md）

> 旧称 spec registry / `codument/specs/`，现为 **behavior 登记表** `codument/behaviors/`。它是项目行为的合并真源（Contract Registry）：track 完成归档时把 `behavior_deltas/` 应用进来。

## 布局

```
codument/behaviors/
├── <capability>.xml              单文件能力（行为较少）
└── <capability>/                 同名文件夹（行为较多时拆分）
    ├── index.xml                 入口，include 子文件
    └── <area>.xml
```

- 单文件 ↔ 同名文件夹**自动演化**：内容过多时把 `<capability>.xml` 拆成 `<capability>/index.xml` + 子文件，沿用分形习惯。
- `behavior://<capability>/requirements/<id>/suites/<id>/cases/<id>` 是定位行为节点的 VFS 路径，被 `behavior-patch` 的 `selector` 与跨文档引用使用；可按节点层级截短，例如只定位到 `requirements/<id>`。

## 节点

```xml
<behaviors capability="csv-export" version="1">
  <requirement id="export-endpoint">
    <statement>系统 SHALL 提供 GET /reports/export.csv …</statement>
    <suite name="csv-export">
      <case name="字段转义"><given>…</given><when>…</when><then>…</then></case>
    </suite>
  </requirement>
</behaviors>
```

- `<behaviors capability version>` 根；`<requirement id>` + `<statement>` + 可嵌套 `<suite>/<case>`。
- 行为状态/适用性等元信息走属性；行为本体是事实真源，**不**复述实现细节（实现真源在代码 + docs/impl）。

## 应用 delta（归档时）

1. 解析 `behavior_deltas/<cap>/delta.xml` 的 `<behavior-patch>`。
2. 对每个 `<upsert|delete|move selector="behavior://…">` 在登记表定位并施改。
3. 登记表内容变化后，若启用 docs 同步，按显式 hook 联动 docs（见 `std/sop/artifact-sync.md`）。

## 设计取舍

- behavior 登记表是**契约**层（"系统应有什么行为"），不与代码/文档争夺实现真源；行为对照失效检测、链接维护等能力可以渐进增强，当前格式保持 XML 结构友好、对拆分友好。
