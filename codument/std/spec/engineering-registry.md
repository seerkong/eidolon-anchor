# engineering 登记表规范（std/spec/engineering-registry.md）

> `codument/engineering/` 是项目的**长期工程知识真源**：实现方式、维护操作、工程规则、示例、参考、排障、runbook、code map。它与 `codument/modeling/` 正交：modeling 答“系统结构真相是什么”，engineering 答“人和 AI 应该如何实现、维护、排障”。
>
> 仅当 `codument/config/engineering.xml` 的 engineering profile `enabled` 时启用；默认关，存量项目无感。
>
> XNL 语法权威见 [std/spec/xnl-format.md](./xnl-format.md)。

## 物理形态：XNL 工作树，宿主 git 版本化

```text
codument/engineering/
├── <plane>/                       global/backend/surface/runtime/storage/agents/actions/...
│   └── <category>/                overview/howto/rules/examples/reference/troubleshooting/runbooks/code-map
│       ├── <topic>.xnl            小主题单文件
│       └── <topic>/               变大后同名文件夹演化
│           ├── index.xnl
│           └── <leaf>.xnl
└── .node-meta/                    节点稳定 id 的 sidecar（可选；命名空间内联 id 优先）
```

- 工作树是磁盘上可读、可手改、宿主 git 可 diff 的 XNL 文件。
- 真 VCS = 宿主 git：`codument/engineering/**.xnl` 由项目自己的 git 版本化、协作、提供历史。
- 不持久化平行 vcs 仓库：xnl-vfs/xnl-vcs 仅作临时合并引擎；其产物放 `.tmp/` 并 gitignore。
- 节点稳定 id 优先用 XNL 多级命名空间内联：`#<plane>.<category>.<topic>.<name>`。

## 与工程分形标准的关系

`engineering` 吸收 `docs-engineering-fractal` 的长期工程知识语义，并把它纳入 codument 的 delta/merge/validate 管理：

- 新的长期工程知识应进入 `codument/engineering/`。
- 不稳定的执行期发现仍先留在 track `analysis/` / `reports/`，稳定后再进入 engineering。

## URI 与引用

canonical URI：

```text
engineering://<plane>/<category>/<topic>/<name>
```

引用规则：

- 指向工程知识：`engineering://...`
- 指向结构真源：`modeling://...`
- 指向行为契约：`behavior://...`
- 指向承重决策：`decision://...`

解析器应按 scheme 自识别引用，不依赖固定 key 白名单。

## 默认 plane

- `global`：跨 plane 的实现/维护知识。
- `backend`、`surface`、`runtime`、`storage`、`pipelines`、`agents`、`operations`：按项目需要启用。

## 默认 category

| category | 装什么 |
|---|---|
| `overview` | 心智模型、组成、边界 |
| `howto` | 可重复维护操作 |
| `rules` | 实现约束、约定、护栏 |
| `examples` | worked example / 样例 |
| `reference` | code map、API/schema/配置表、映射 |
| `troubleshooting` | 故障模式、诊断、修复 |
| `runbooks` | 运维/发布/恢复执行手册 |
| `code-map` | 代码路径与工程知识节点的映射 |

## 节点

节点 schema 详见 `std/spec/engineering-node-schema.md`。要点：

- 文件 = XNL。
- `kind`、`related`、`applies_to` 等常规语义属性写进 XNL `{}` 属性块；metadata 只留给系统级解析/合并字段。
- 描述性内容用中文；代码路径、接口名、文件名、URI、`#id` 保持英文。
- 长文用 TextElement block style，避免 XML/Markdown 转义污染。
- 与 modeling 不重复：结构/事实源/状态机归 modeling；engineering 只写实现和维护视角，必要时引用 `modeling://...`。

## 应用 delta

见 `std/spec/engineering-delta.md`。简述：base = track create 时记录的宿主 git commit id；archive 取 base + ours + theirs，做节点级 3-way merge，写回 `codument/engineering/`；冲突 issues-first，不静默覆盖。
