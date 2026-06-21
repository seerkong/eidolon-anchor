# behavior delta 编写规范（std/spec/behavior-delta.md）

> 口径：旧称 spec / spec_deltas，现统一为 **behavior**。每个 track 在 `tracks/<id>/behavior_deltas/<capability>/delta.xml` 声明对行为登记表（`codument/behaviors/`，见 `behavior-registry.md`）的增删改。

## 形态

```xml
<behavior-patch capability="csv-export" version="1">
  <upsert selector="behavior://csv-export/requirements/export-endpoint">
    <requirement id="export-endpoint">
      <statement>系统 SHALL 提供 GET /reports/export.csv，复用报表查询过滤条件，以 RFC 4180 CSV 流式返回。</statement>
      <suite name="csv-export">
        <case name="过滤条件一致">
          <given>报表页应用了过滤条件 F</given>
          <when>请求 /reports/export.csv 携带 F</when>
          <then>导出行集与在线视图在 F 下一致</then>
        </case>
      </suite>
    </requirement>
  </upsert>
</behavior-patch>
```

## 规则

- 根节点 `<behavior-patch capability="<capability>" version="1">`；一个 capability 一个 delta 目录。
- **mutation = wrapper 标签 + `selector`**：`<upsert|delete|move selector="behavior://...">`；`selector` 用 **`behavior://`** 虚拟路径定位行为登记表中的节点（取代旧 `spec://`）；`move` 还必须带 `to="behavior://..."`。
- **行为用例用可嵌套 `<suite>` / `<case>`**（given/when/then），与各语言单测库的多层级、场景嵌套对齐；单个 delta 变长可拆为同名文件夹多文件。
- `<requirement>` / `<statement>` 承载行为陈述；`<suite>/<case>` 承载可执行验收。
- 节点要对拆分友好：`capability` → `requirement` → `statement` / `suite`，便于 single-file ↔ same-name-folder 演化。

## 与 track / 归档的关系

- track 的 `<Ports>` 把 `behavior_deltas/`（input 物料，`domain="behavior"`）与 `codument/behaviors/`（output `name="behavior"`）显式接起来。
- 归档时（`codument-archive`）按 `<upsert|delete|move>` wrapper + `behavior://` selector 把 delta 应用进 `codument/behaviors/`（见 `behavior-registry.md`）。
- 行为用例 `<suite>/<case>` 指导测试编写，是 `codument-verify` 的验收依据之一。
