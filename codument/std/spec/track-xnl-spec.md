# Track XNL 规范

`codument/tracks/{pending,active}/<id>/track.xnl` 是 Track 的结构、状态、调度与 hook 真源；归档后位于 `codument/tracks/archived/YYYY-MM/<timestamp>-<id>/track.xnl`。新文件必须由 `codument track create <id> --stage pending|active` 生成骨架，调用方不得自行填写 `apiVersion`。

Track Kind authority 位于 `codument/std/kinds/KindDefinitions/Track/manifest.xnl`。当前版本为 `codument.tech/v1alpha1`，XNL 通用语法遵循 `xnl-format.md`。

## 1. 目录约定

```text
tracks/
  pending/<id>/
  active/<id>/
  archived/YYYY-MM/<timestamp>-<id>/

<track-dir>/
  track.xnl
  proposal.md
  design.md
  behavior_deltas/<capability>/delta.xnl  # CLI 生成的版本化 BehaviorPatch
  decisions.xnl                 # 首个真实决策出现时才创建
  decisions/**/*.xnl            # 可选分片
  analysis/                      # 可选迭代期记忆
  memory/                        # 可选长期记忆候选
  reports/                       # 可选验证报告
```

`proposal.md` 与 `design.md` 是 Track Kind 的 required files。普通 worker 不拥有 `track.xnl`；track executor 决定状态转换与验收结论。开始、拒绝、放弃等状态通过 `codument track task transition` 写回；DONE 必须通过 `codument track task complete <track-id> <task-id> -- <verification-command>`，由 CLI 在验证退出 0 后原子写回状态、验收标记与更新时间。

根 `decisions.xnl` 仅在首次出现真实决策时创建；无 decision 时不落空文件。`decisions/**/*.xnl` 只在 decision forest 需要按 owner/topic 分片时创建。

## 2. Canonical DSL

下例是 `codument track create` 生成骨架并填写语义后的完整投影。`#id`、`apiVersion`、`version`、初始状态与时间字段由 CLI 写入；作者只保留这些 receipt 值，不从示例复制。

```xnl
<Track #add-csv-export apiVersion="codument.tech/v1alpha1" version="1" {
  status = "in_progress"
  goal = "为报表新增 CSV 导出"
  description = "后端端点、前端入口、测试与文档"
  question_mode = "decision-tree"
  question_severity = "auto"
  commit_mode = "manual"
  created_at = "2026-08-15T10:00:00Z"
  updated_at = "2026-08-15T10:00:00Z"
} (
  <Ports { scope = "track" } [
    <MaterialBundle #code {
      role = "input"
      name = "code"
      domain = "code"
      path = "vfs://@/src/"
    }>
    <MaterialBundle #tests {
      role = "output"
      name = "tests"
      domain = "test"
      path = "vfs://@/test/"
    }>
  ]>
  <TaskSpace #space_add-csv-export {
    name = "add-csv-export"
    version = "1"
    child_mode = "dag"
  } (
    <SubNodes [
      <TaskGroup #P1 { name = "实现" status = "ACTIVE" priority = "P0" order = 0 } (
        <Description ?>实现 CSV 导出。</?>
        <SubNodes [
          <Task #P1-T1 { name = "序列化器" status = "NOT_STARTED" priority = "P0" order = 0 } (
            <Acceptance [
              <Criterion #P1-T1-AC1 { checked = false } ?>转义测试通过。</?>
            ]>
          )>
        ]>
      )>
      <TaskGroup #P2 { name = "收口" status = "NOT_STARTED" order = 1 }>
    ]>
  )>
  <Schedule { max_concurrent = 3 spot_check = true } [
    <Dag { for = "space_add-csv-export" } [
      <Node #P2 [
        <After { ref = "P1" }>
      ]>
    ]>
  ]>
  <Hooks []>
)>
```

## 3. XNL 通道约束

- `<Track #id apiVersion="..." version="...">`：`#id` 是资源 identity；`apiVersion` 与 `version` 是 XNL metadata。
- Track 的常规字段放根 `{}`，不得创建 `<Metadata>` 包装节点。
- `Ports`、`SubNodes`、`Schedule`、`Hooks`、`Acceptance`、`Gate` 等集合子域使用 `[]`。
- `TaskSpace`、`Description` 等只出现一次的子域使用 `()`。
- `[]` 只承载该集合的成员，不用于容纳 singleton 配置。
- Task、TaskGroup、MaterialBundle、Node 等节点的普通属性放各自 `{}`；不要误放到 metadata。
- Track XNL 不使用 XML namespace，也不写 `cdt:` 前缀。`GapLoop`、`HumanConfirm`、`AttractorCheck`、`Acceptance`、`Gate` 等标签本身已由 Track Kind 定义语义。

根属性：

| 字段 | 约束 |
|---|---|
| `status` | `new\|in_progress\|completed\|cancelled` |
| `goal` / `description` | 非空文本 |
| `question_mode` | 当前为 `decision-tree` |
| `question_severity` | `auto\|light\|normal\|deep` |
| `commit_mode` | `auto\|manual` |
| `created_at` / `updated_at` | ISO 8601 |
| `gap_round` | 可选非负整数；gap-loop 父层运行 `codument track gap-round`，由 CLI 维护 |
| `modeling_base_commit` / `engineering_base_commit` | 可选归档基线 |

根状态是可恢复的生命周期状态，不是永久锁。`completed | cancelled` Track 在用户明确续跑或补充任务时，可运行 `codument track transition <id> in_progress` 恢复；若唯一 authority 已归档，CLI 将其移动回 `tracks/active/<id>/`。恢复不会撤销归档时已提升的 behavior、modeling、engineering、decision 或 artifact；再次进入 `completed` 仍必须通过当前任务树的 completion gate。若 archived 中存在多个同 id authority，CLI 必须拒绝猜测并要求先消除歧义。

## 4. 结构轴

`TaskSpace` 的 `SubNodes` 第一层 `TaskGroup` 即 phase。`TaskGroup` 与 `Task` 可以递归嵌套，id 在单个 Track 内全局唯一。

- 节点状态：`NOT_STARTED | ACTIVE | DELEGATED | FORWARDED | DONE | REFUSED | ABANDONED`。
- 每层默认按 `order` 顺序执行；需要 DAG 时在父节点 `{ child_mode = "dag" }`。
- `Acceptance` 与 `Gate` 的 `Criterion` 使用 `checked = true|false` 记录验收事实。
- `Description` 是 singleton 文本子域，应放 `()`。
- `priority` 使用 `P0|P1|P2`；`blocker` 可记录当前阻塞原因，`commit` 可记录 auto commit 证据。三者都是普通节点属性，放 `{}`；`blocker`/`commit` 存在时不得为空。

## 5. 调度轴

`Schedule []` 与 `TaskSpace` 并列。可在 `Schedule {}` 设置 `max_concurrent`（正整数）与 `spot_check`（boolean）；缺省按执行器能力串行或保守并行。每个 `Dag { for = "<parent-id>" }` 只描述该父节点直接子节点之间的边：

```xnl
<Schedule [
  <Dag { for = "P1" } [
    <Node #P1-T3 [
      <After { ref = "P1-T1" }>
      <After { ref = "P1-T2" }>
    ]>
  ]>
]>
```

`for` 必须指向 `child_mode = "dag"` 的节点；`Node #id` 与 `After.ref` 只能引用该父节点的直接子节点；图必须无环。没有依赖的层不写 `Dag`。

## 6. Hook 轴

`Hooks []` 可位于 Track 或 TaskGroup/Task 的 `()` 中。`Hook.on` 支持 `track:before|after`、`phase:before|after`、`task:before|after`。一个 Hook 的操作是 singleton，放在 `()`：

```xnl
<Hooks [
  <Hook { on = "phase:after" } (
    <AttractorCheck { use = "coding" }>
  )>
  <Hook { on = "track:after" } (
    <HumanConfirm>
  )>
]>
```

`AttractorCheck.use` 必须能解析到 `config/attractor-profiles.xnl`。`GapLoop` 的完整运行协议见 `std/operations/gap-loop.md`。

GapLoop 默认归属 phase 的 `phase:after` hook。一个 Track 若已在任一第一层 phase 配置 `phase:after GapLoop`，不得再在根 `track:after` 配置 GapLoop，否则同一次实现会重复执行语义相同的收敛循环；validator 必须将其报为 `track.hook.gap-loop-duplicate`。

## 7. 文件 authority 与兼容

- 新建和所有状态写入只使用 `track.xnl`。
- legacy `track.xml` 在兼容窗口内仍可读、校验和归档。
- 同一目录同时存在 `track.xnl` 与 `track.xml` 是 authority conflict，必须停止并明确处理。
- `codument upgrade-workspace` 对 legacy XML 执行结构化转换：先备份，再写临时 XNL，解析和校验通过后原子替换并删除 XML；失败时保留旧文件并返回 `review-required`。
- 程序化转换后，AI 仍须按当前规范 review 语义，尤其检查 singleton/collection 通道、DAG 引用与 hook 操作。

## 8. 严格校验

1. 根必须是唯一的 `<Track>`，必须有 `#id`、当前 `apiVersion` 与 `version`。
2. required files `proposal.md`、`design.md` 必须存在。
3. 根普通字段位于 `{}`，不得出现 `<Metadata>`。
4. 必须有一个 `TaskSpace`；其第一层至少一个 phase；节点 id 唯一且状态合法。
5. collection subdomain 使用 `[]`，singleton subdomain 使用 `()`。
6. 所有 DAG 作用域、节点和前驱引用可解析且无环。
7. Hook 的 `on`、操作类型和 profile 引用合法。
8. `priority`、`blocker`、`commit` 与 `Schedule.max_concurrent/spot_check` 取值合法，且不存在 root/phase 重复 GapLoop。
9. `behavior_deltas/**/*.xnl` 按 BehaviorPatch Kind 独立校验；骨架由 `codument behavior-patch create <track-id> <capability>` 生成。legacy XML 只作兼容输入。

CLI 校验：

```bash
codument validate <track-id> --strict
```
