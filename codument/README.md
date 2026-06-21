# Codument Workspace

本目录是项目内自包含的 Codument 工作区。它保存项目吸引子、行为登记表、track、内置规程与操作提示词，使 AI 助手可以在项目本地完成 planning、实现、验证、归档和迁移。

Codument 的核心状态文件是 `tracks/<id>/track.xml`。它把一次变更拆成三条正交轴：

| 轴 | 位置 | 作用 |
|---|---|---|
| 结构 | `<TaskSpace>` | 记录任务树、阶段、任务状态与验收信息 |
| 调度 | `<Schedule>` | 记录顺序 / DAG 依赖与并行约束 |
| 行为 | `<Hooks>` | 记录方向审查、gap-loop、人工确认、制品同步等生命周期动作 |

旧 `plan.xml`、`specs/`、`spec_deltas/` 等路径已迁移到当前标准：`track.xml`、`behaviors/`、`behavior_deltas/`。

## 目录职责

```text
codument/
├── std/                         内置标准、规程、操作提示词；upgrade-workspace 会刷新
│   ├── AGENTS.md                AI 入口与路由
│   ├── root-agents.md           项目根 AGENTS.md 受管块模板
│   ├── kernel-pointer.md        Codument 与通用 workflow/task 内核的关系
│   ├── spec/                    文件格式规范
│   ├── sop/                     内置执行规程
│   └── operations/              codument-* skill 的权威操作 body
├── attractors/                  项目、产品、知识分层、docs、memory 等吸引子
├── config/                      profile 与 operation hook 配置
├── workflows/                   结构化 workflow definitions / instances
├── sop/                         项目自定义执行流程
├── backlog/                     候选工作与 AI 自主度规则
├── memory/                      长期记忆：lessons / incidents / patterns / summaries
├── behaviors/                   行为登记表，归档时由 behavior_deltas 提升
└── tracks/                      运行期创建的变更追踪目录
```

## 当前标准

1. `track.xml` 是 track 状态真源；任务状态在 XML 内维护，不再依赖 `state.json`。
2. 第一层 `TaskGroup` 表示 phase；其下可继续嵌套 `TaskGroup` 或 `Task`。
3. 调度按层声明：需要并行的层标 `cdt:child-mode="dag"`，依赖写入 `<Schedule><Dag>`.
4. `summary` 不手维护；统计由工具遍历 TaskSpace 派生。
5. 变更输入输出使用目录物料：`behavior_deltas/`、`docs/`、`codument/behaviors/` 等。
6. 能力开关使用 `config/attractor-profiles.xml` 的 `<Profile enabled>`；不再使用 `config/feature.json`。
7. 内置规程在 `std/sop/`，项目自定义规程在顶层 `sop/`，结构化 workflow 放在 `workflows/`。
8. 行为登记表使用 `codument/behaviors/`；行为增量使用 `behavior_deltas/`；selector 使用 `behavior://`。
9. `std/operations/` 是各 `codument-*` skill 的权威提示词 body；agent skill 目录只安装薄壳入口。

## 常用入口

- `std/AGENTS.md`：给 AI 助手的总入口。
- `std/spec/track-xml-spec.md`：`track.xml` 格式。
- `std/spec/behavior-delta.md`：行为增量格式。
- `std/spec/behavior-registry.md`：行为登记表格式。
- `std/sop/workflow.md`：Codument 工作流总纲。
- `std/operations/README.md`：所有操作提示词索引。
