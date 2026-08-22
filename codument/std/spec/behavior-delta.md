# Behavior delta 编写规范

每个 pending 或 active track 在 `behavior_deltas/<capability>/delta.xnl` 声明对 `codument/behaviors/` 的增删改。新文件必须先由 CLI 生成当前 Kind 版本骨架：

```bash
codument behavior-patch create <track-id> <capability>
```

AI 随后在骨架中编写 mutation 与行为正文；不得自行猜测或复制 `apiVersion`。

## Canonical DSL

下例是 `codument behavior-patch create` 生成骨架后的填写结果。`#id`、`apiVersion` 与 `version` 来自 CLI scaffold，不能从示例复制。

```xnl
<BehaviorPatch #track.add-csv-export.behavior_patch.csv-export apiVersion="codument.tech/v1alpha1" version="1" {
  capability = "csv-export"
} (
  <Mutations [
    <Upsert { selector = "behavior://csv-export/requirements/export-endpoint" } (
      <Requirement #export-endpoint (
        <Statement ?>系统 SHALL 提供 GET /reports/export.csv，并以 RFC 4180 CSV 流式返回。</?>
        <Suites [
          <Suite #csv-export { name = "CSV export" } (
            <Cases [
              <Case #same-filter (
                <Given ?>报表页应用了过滤条件 F</?>
                <When ?>请求 /reports/export.csv 携带 F</?>
                <Then ?>导出行集与在线视图在 F 下一致</?>
              )>
            ]>
          )>
        ]>
      )>
    )>
    <Delete { selector = "behavior://csv-export/requirements/obsolete" }>
    <Move {
      selector = "behavior://csv-export/requirements/export-endpoint"
      to = "behavior://reporting/requirements/export-endpoint"
    }>
  ]>
)>
```

## 通道与结构规则

- `#id` 是资源 identity；`apiVersion`、`version` 是系统 metadata；`capability`、`selector`、`to` 是普通属性，放 `{}`。
- `<Mutations []>` 是 mutation 集合，只允许 `Upsert|Delete|Move`。
- `<Upsert>` 恰有一个目标行为节点，因此目标放 `()`；`Delete` 无正文；`Move` 必须有 `to`。
- selector 使用 `behavior://<capability>/requirements/<id>/suites/<id>/cases/<id>`，可按层级截短。
- 行为层级使用 `Requirement/Statement/Suites/Suite/Cases/Case/Given/When/Then/Ands/And`；单值子域放 `()`，集合放 `[]`。
- `Requirement`、`Suite`、`Case` 可各自包含一个 singleton `<KnowledgeHint { target = "docs-profile" href = "vfs://..." strength = "hint" }>`。它只建立到建模/工程文档 profile 的弱关联；目标暂时不可解析时只报告 warning，不阻断行为归档。
- 规范性需求使用 SHALL / MUST。每个 capability 至少一个 Requirement，每个可测试需求至少一个 Case。
- 普通节点属性放 `{}`。合法 XNL word id 使用 `#id`；无法作为 word 的历史 id 可用 `{ id = "原值" }` 无损承载。

## 生命周期与兼容

- Track 的 `Ports` 把 `behavior_deltas/` input 与 `codument/behaviors/` output 显式连接。
- validate、show、verify、gap-loop 与 archive 均以 `delta.xnl` 为 canonical 输入。
- 归档按 mutation 顺序在 transaction staging 中更新 Behavior registry，全部 registry 验证成功后统一 commit。
- legacy `behavior_deltas/**/*.xml` 与 `<behavior-patch>` 仍可读取和程序化迁移，但新 track 不得创建 XML patch。
- `upgrade-workspace` 先备份再迁移；程序化转换失败时保留原文件并返回 `review-required`，由 AI 按本规范 review 和修正。
