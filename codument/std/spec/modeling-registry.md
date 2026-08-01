# modeling 登记表规范（std/spec/modeling-registry.md）

> `codument/modeling/` 是项目的**领域建模真源**（领域本体 / attractor 载体）。与 `codument/behaviors/`（行为契约）和 `codument/engineering/`（工程知识真源）正交：behaviors 答“系统应有什么可测行为”，modeling 答“系统的结构真相是什么”（对象、类型、状态机、模块依赖、事实源、actor），engineering 答“人和 AI 应该如何实现、维护、排障”。
>
> modeling **默认启用**：缺失 `codument/config/modeling.xml` 时按 `enabled=true` 处理，fresh init 模板也生成 `enabled="true"`；已有 workspace 显式配置 `enabled="false"` 时必须保持关闭，不得被默认值或升级覆盖。
>
> **启用状态与 delta 义务分离**：只有对象、状态机、policy、模块边界、事实源、actor/component IO 等结构知识变化时，track 才生成或维护 `modeling_deltas/`；普通 track 若无结构变化，不强制生成 delta，也不创建空 registry。
>
> XNL 语法权威见 [std/spec/xnl-format.md](./xnl-format.md)。

## 物理形态：xnl-vfs 工作树，宿主 git 版本化

```
codument/modeling/
├── <plane>/                      domain(canonical) + 派生 plane(backend/surface/runtime/...)
│   └── <context>/                bounded context
│       ├── index.xnl             本 context 的节点（过大才拆同名子文件）
│       └── <kind>/<id>.xnl       拆分后的节点文件
└── .node-meta/                   节点稳定 id 的 sidecar（可选；命名空间内联 id 优先）
```

- 工作树是磁盘上**可读、可手改、宿主 git 可 diff** 的 XNL 文件（`xnl-vfs` `LocalFsVfsPersistence`）。
- **真 VCS = 宿主 git**：`codument/modeling/**.xnl` 由项目自己的 git 版本化、协作、提供历史。
- **不持久化平行 vcs 仓库**：xnl-vfs/xnl-vcs 仅作**临时合并引擎**（归档时的节点级 3-way），其产物（如 `.xnl-vcs/`）放 `.tmp/` 并 **gitignore**，不入库——避免可变控制文件（refs/HEAD/logs/workspace）在多人协作时冲突，也避免与宿主 git 重复记账。
- 节点稳定 id 优先用 XNL 多级命名空间内联（`#<context>.<name>` 或跨 plane `#<plane>.<context>.<name>`）；需要时用 `.node-meta/<name>.node.xnl` sidecar 兜底。

## 载体与定位

- 文件 = XNL（`xnl-core`）。`DataElement`（结构）+ `TextElement ?marker`（desc / TypeScript / mermaid / 伪代码，**零转义**）。
- 节点 id = `XnlWord` 命名空间：`#<context>.<name>`（类似 `命名空间::类名`，全局唯一）。
- `modeling://<plane>/<context>/<id>` 是跨文档引用的 VFS 路径，映射到 XNL `#<context>.<id>`；mutation 在 `metadataIdMode:"identity"` 下按 id 命中。
- 单文件 ↔ 同名文件夹**自动演化**：内容过大时把 `index.xnl` 节点拆为 `<kind>/<id>.xnl`（宿主 git 跟踪 rename）。`codument modeling lint` 给出拆分建议——默认阈值 **> ~400 行 或 > ~8 个顶层建模节点**（可在 `config/modeling.xml` 配）；lint 只建议，实际拆分由模型按 `folder-manifest.md` 应用。

## 节点（kind 谱系 + 最小表征）

节点 schema 详规见 `std/spec/modeling-node-schema.md`。要点：

- **kind 谱系**：越靠内核越用 DEPA 跨领域概念（裸名 kind：`entity`/`enum`/`state-machine`/`module`/`component`/`port`/`actor`/`policy`）；越靠 shell 越用命名空间领域 kind（`surface:route`/`backend:endpoint`/`cli:command`…）。
- **节点属性承载**：`kind`、`fact_grade`、`single_writer`、`depends_on` 等常规语义属性写进 XNL `{}` 属性块；metadata 只留给系统级解析/合并字段。
- **最小必备表征**（CLI 校验）：`entity` 必带 `types`+`fact_grade`+`single_writer`；`state-machine` 必带 `mermaid`；`module` 必带 `depends_on`+capsule-tree（**到文件/符号级**，非仅 contract/logic/support）；`component` 必带 `runtime`/`input`/`config`/`output` 四个 `types` 块。
- **不重复 behaviors**：可测行为契约归 `behaviors`；modeling 的 behavior/policy 节点**引用 `behavior://…`**，不复述 case。

## 应用 delta（归档时）

见 `std/spec/modeling-delta.md`。简述：base = track create 时记录的**宿主 git commit id**；archive 取 base（从宿主 git 物化）+ ours（当前工作树）+ theirs（track 的 `modeling_deltas`），用 **xnl-vfs `xnlFileHandler.merge` 临时**做真实节点级 3-way 合并。结果先进入与 behavior / engineering 共用的 transaction staging；全部 prepare、校验和冲突检测成功后才做 rollback-capable commit，成功后才移动 track。首次有效 delta 可在 commit 时创建 registry；无 delta 不创建空 registry。

## 初始态与校验

- missing / empty modeling registry 是合法初态：`codument modeling validate` 报 warning，不报 missing-domain error。
- registry 一旦包含实际 XNL 节点，就必须存在 `domain` plane；未知 derived plane 仍只报 warning。
- 首次有效 `modeling_deltas` 归档通过真实三方 merge 产生 `codument/modeling/`；仅仅 enabled 不会物化空目录。

## 设计取舍

- modeling 是**结构真源**层，不与代码/docs 争夺实现真源（实现真源在代码 + `codument/engineering`）。
- 复用 xnl 的**节点级 merge 算法**（优于 git 行级合并），但**不持久化平行 vcs 仓库**——历史/协作交宿主 git，xnl-vfs/vcs 只当临时合并引擎。
- 不自建 delta 节点类型与 apply 算法。
- 默认开：缺失 `config/modeling.xml` 视为 enabled；只有显式 `enabled="false"` 才跳过 modeling 全流程。
- enablement 只决定能力是否可用，不等于每个 track 都必须生成 modeling delta。
