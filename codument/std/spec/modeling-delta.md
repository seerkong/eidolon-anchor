# modeling delta 编写规范（std/spec/modeling-delta.md）

> 每个 track 对 modeling 登记表（`codument/modeling/`，见 `modeling-registry.md`）的增删改，用**目标态节点 + 节点级 3-way 合并**表达，而非自建 delta 节点类型。真 VCS 是宿主 git；xnl-vfs 只当**临时合并引擎**（不持久化平行 vcs 仓库）。
>
> 仅当 `codument/config/modeling.xml` 的 modeling profile `enabled` 时启用。
>
> XNL 语法权威见 [std/spec/xnl-format.md](./xnl-format.md)。

## 形态：目标态节点（modeling_deltas）

- track 在 `tracks/<id>/modeling_deltas/<plane>/<context>.xnl` 写**改动节点的目标态**（可评审，像 `behavior_deltas/`，宿主 git 跟踪）。每个节点带稳定多级命名空间 id（`#<context>.<name>` 或 `#<plane>.<context>.<name>`）。
- 它是归档 3-way 合并的 **theirs** 侧；registry 工作树是 **ours** 侧；base 见下。

```xnl
<!-- tracks/<id>/modeling_deltas/domain/resource.xnl -->
<object #resource.skill_tool kind="entity" fact_grade="authoritative_fact" single_writer="resource.store" [
  <desc ?>聚合型资源：可编辑/打包/恢复的文本文件集合。</?>
  <types ?ts1>
  interface SkillTool { key: string; appId: string; status: SkillToolStatus; isArchived: boolean }
  enum SkillToolStatus { Draft="draft", Online="online" }
  </?ts1>
  <fact-source ?>唯一写入者 resource.store；file_contents 为只读投影，不反写。</?>
]>
```

## 增删改移（git 语义，不自建 op）

| 操作 | 怎么表达 |
|---|---|
| 新增 / 修改节点 | 在 `modeling_deltas` 写目标态节点（按 `#id` 命中：无则新增，有则更新） |
| 删除节点 | `modeling_deltas` 显式标记删除（或目标态省略该节点 + 删除清单）；合并时该节点从 registry 移除 |
| 重命名 / 移动文件 | `vfs.rename`（宿主 git 记录 rename） |
| 单文件内节点移动 | `XnlMutation` `TREE_MOVE`（`xnl-core`，按 `#id`） |

## base 锚定（决策 A，锚在宿主 git）

- **track create 时记录当时 `codument/modeling` 所在的宿主 git commit id** 作为 3-way base，写入 track 元信息。
- 归档时 base 从宿主 git 物化（`git show <commit>:codument/modeling/...`），与当前工作树(ours) + `modeling_deltas`(theirs) 做三方合并，支持并发 track / registry 已前进。

## 应用（归档时，机械、临时引擎）

1. 物化三方：base（宿主 git 记录的 commit）+ ours（当前 `codument/modeling` 工作树）+ theirs（track 的 `modeling_deltas`），各加载为 xnl-vfs 快照（内存 / `.tmp/`，不持久化）。
2. 节点级 3-way 合并：`xnl-vfs` `xnlFileHandler.merge(base, ours, theirs)`（底层 `xnl-core` `diffNodes`+`applyMutations`，`metadataIdMode:"identity"`，按 `#id` 命中）。
3. 按下方**冲突解决策略**处理冲突。
4. 合并结果写回 `codument/modeling` 工作树，由宿主 git 提交。`.tmp/` 临时产物不入库。
5. 跑 `codument modeling lint`（分形拆分）。
6. 模型把设计方案按类目回写 `docs/impl/`。

## 冲突解决策略（保守默认 + 可配）

默认**保守**：能无歧义自动合并的自动；**真冲突一律 issues-first 报告并暂停**（像 confirm gate），不静默选边。

| 情形 | 默认 |
|---|---|
| 不相交节点（theirs 改 A、ours 改 B） | ✅ 自动 |
| 同节点不同子部（theirs 改 A 的 `types`、ours 改 A 的 `mermaid`） | ✅ 自动 |
| 纯新增新 id / 纯删除未被动过的节点 | ✅ 自动 |
| 同节点同子部异内容 | ❌ 默认人工 |
| `DELETE_MODIFY`（theirs 删 A、ours 改 A） | ❌ 默认人工 |
| `RENAME_RENAME`（两边改名到不同处） | ❌ 默认人工 |
| ADD/ADD 同 id 异内容 | ❌ 默认人工 |

- 报告每条真冲突给 `{ metadataId, base/ours/theirs 片段 }`；归档 agent 低歧义的可判定并记录 `choice`，真语义冲突升级给用户逐条选 `choice: "ours"|"theirs"|"base"` 或手改。
- **按冲突类型可在 `config/modeling.xml` 配**覆盖默认，例如把 `delete_modify` 设为 `theirs` 自动尊重删除；缺省全部走人工。配置字段（建议）：
  ```xml
  <modeling-config>
    <merge-policy>
      <conflict type="same-field" resolve="human"/>
      <conflict type="delete-modify" resolve="human"/>
      <conflict type="rename-rename" resolve="human"/>
      <conflict type="add-add" resolve="human"/>
    </merge-policy>
  </modeling-config>
  ```
  `resolve` 取 `human` | `ours` | `theirs` | `base`。

## 与 track / 归档的关系

- track 的 `<Ports>` 把 `modeling_deltas/`（input，`domain="modeling"`）与 `codument/modeling/`（output `name="modeling"`）显式接起来。
- desc/types/mermaid/伪代码都是 `TextElement`，整块当 `valueAfter` 替换，不被 XML 实体污染。
- modeling 节点引用 `behavior://…` 不复述可测 case。

## 多文件 import（依赖）

跨文件命名空间引用（`<Import as="X" src="vfs://...">`）依赖 xnl.ts 侧 `add-vfs-import-resolver`；就绪前以“单 context 单文件 + 目录 glob 回退”起步。
