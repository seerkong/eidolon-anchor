# Docs Knowledge Attractor

## 目的

当 `knowledgeSync.enabled=true` 时，本文件是项目知识维护的入口 attractor。

文档系统由两套并列的分形标准组成：

```text
docs/modeling/  # 建模真源与派生建模
docs/impl/      # 实现、操作、示例、参考、排障知识
```

创建或更新 docs 前，必须先阅读详细标准：

- [docs-modeling-fractal/index.md](@codument/std/docs-modeling-fractal/index.md)：`docs/modeling/` 的规范标准。
- [docs-impl-fractal/index.md](@codument/std/docs-impl-fractal/index.md)：`docs/impl/` 的规范标准。

本文件只保留路由规则、通用元数据、track 同步检查清单。不要把具体建模文件模板或实现平面细则塞回本文件；这些内容应维护在两份分形标准中。

> **上层语义**：一条信息该落 `docs/` 还是 track/behaviors/decisions/memory、何时从 track **晋升**进 owner 文档、冲突时谁是真源——见 [attractors/knowledge-tiers.md](./knowledge-tiers.md)。每个标准文件夹"装什么"由其 `index.md` 的**目录职责块**就地声明，规范与补齐见 [std/spec/folder-manifest.md](@codument/std/spec/folder-manifest.md)。

## 真源边界

保持这些真源互相分离：

- `codument/behaviors/`：能力契约（行为）注册表，面向行为 case 与测试生成。
- 源码、测试、配置：可执行真源。
- `docs/modeling/`：规范化建模真源与派生建模。
- `docs/impl/`：实现与运维知识。
- `codument/decisions/`：从 track 局部决策中提升出的长期决策。
- `codument/memory/`：长期 lessons、incidents、patterns、summaries。

`docs/` 不应复制全部 behavior 或全部代码。它保存的是本体、心智模型、派生设计、实现指导、运维知识，以及让 AI 从知识进入代码的 code map。

## 根结构

默认根结构：

```text
docs/
  index.md
  migration-map.md
  _assets/
  modeling/
  impl/
```

规则：

- `docs/modeling/` 与 `docs/impl/` 是根层唯一两套正式知识系统。
- `docs/migration-map.md` 是根级迁移台账，不是知识平面。
- `docs/_assets/` 保存辅助资产，不是正式正文真源。
- implementation plane 必须放在 `docs/impl/` 下。
- modeling plane 必须放在 `docs/modeling/` 下。

Good：

```text
docs/modeling/
docs/impl/global/
docs/impl/runtime/
docs/impl/commands/
```

Bad：

```text
docs/modeling/
docs/<global-implementation-knowledge>/
docs/<implementation-plane>/
```

## 通用 Frontmatter（受控精简 schema）

每份正式 Markdown 文档以 frontmatter 开头。**保持小而稳**——下面是唯一允许的字段集，不要再加数组型大字段。

固定字段（每份文档都写）：

```yaml
---
knowledge_plane: domain        # 平面名；docs/modeling|impl 已由路径表达 system，故不写 knowledge_system
doc_role: canonical            # canonical|derived|guide|rules|howto|example|reference|troubleshooting|compat|legacy
status: active                 # active|draft|compat|legacy|deprecated
last_verified: YYYY-MM-DD       # 最后一次与源码/事实核对的日期
---
```

条件字段（只在有意义时写，且**各最多一行**）：

- `context:`：建模 context 名——**仅 modeling 文档**。
- `derived_from:`：**只写一个**最近的 canonical 父来源——仅 derived 文档。**禁止堆成多行清单**。
- `canonical_source:`：compat/legacy 文档指回的 canonical 来源。

明确**不进 frontmatter**（这是当年 yaml 过重的根因）：

- 代码路径 → 写 `code-map.md` 或正文（impl 正文可写）。
- `code_paths` / `topics` 等数组、长 `derived_from` 清单 → 写正文；长来源关系用 `code-map.md` 承载。
- 文档路径与 frontmatter 语义必须一致。

## Modeling System

`docs/modeling/` 包含所有建模平面。**递归规则同构，类目词汇随领域而变**：

```text
docs/modeling/<modeling-plane>/
  index.md            # 只导航
  glossary.md
  contexts/
    index.md
    <context>/
      index.md
      code-map.md
      <category>/     # 类目由该 plane 的建模视角决定，不是固定三件套
```

必需 plane：`domain`（canonical 本体）。其他 derived plane（`server`、`uiux`、`runtime`、`api`、`storage`、`pipeline`……）由项目按领域自定义。

类目示例（**不是强制目录名**）：`domain` 常用 `objects/policies/workflows/`；`server` 用 `routes/storage/contracts/...`；其他领域用 `sources/transforms/sinks` 等。

如何为本领域选类目、各文件写法见 [docs-modeling-fractal/index.md](@codument/std/docs-modeling-fractal/index.md)。

## Implementation System

`docs/impl/` 包含所有实现平面。**递归规则同构，类目词汇可按领域替换**：

```text
docs/impl/<implementation-plane>/
  index.md            # 只导航
  <category>/         # 推荐默认六类，可领域自定义
    <topic>/<leaf>.md
```

推荐 plane：`global`（跨 plane 实现知识）。其他 plane（`backend`、`frontend`、`runtime`、`storage`、`pipelines`、`agents`、`operations`……）由项目自定义。

推荐默认类目（**起点，非法律**）：`overview / howto / rules / examples / reference / troubleshooting`；领域不适配时可在 plane 第一层替换为自定义类目集。详见 [docs-impl-fractal/index.md](@codument/std/docs-impl-fractal/index.md)。

## 同名文件夹演化

主题较小时优先使用单文件。

当出现以下情况时，升级为同名文件夹：

- 单文件已经难以导航。
- 出现多个稳定子主题。
- 多人或多分支编辑频繁冲突。
- AI 反复无法定位正确章节。
- 一个文件混入了多个不相关关注点。

演化方式：

```text
<name>.md
-> <name>/index.md
-> <name>/<subtopic>.md
```

规则：

- 保留原概念名称。
- 新的 `index.md` 只做导航。
- 优先直接放子 `.md` 文件，不要过早增加更深目录。
- 如果旧路径被引用过，更新局部链接与 `docs/migration-map.md`。
- 不要为了结构好看拆分小文档。

## Migration Map

使用唯一根级迁移映射：

```text
docs/migration-map.md
```

模板：

```markdown
---
knowledge_system: impl
knowledge_plane: global
doc_role: reference
status: active
last_verified: YYYY-MM-DD
---

# Documentation Migration Map

| Old Path | New Path | Status | Notes |
|----------|----------|--------|-------|
```

状态：

- `migrated`：同职责迁移。
- `absorbed`：有价值内容被吸收到新的 canonical/derived 文档。
- `compat`：旧路径仍作为兼容说明保留。
- `deprecated`：明确废弃。

## Assets

非正文辅助材料放入 `docs/_assets/`：

```text
docs/_assets/
  sql/
  scripts/
  schemas/
  ui/
  data/
```

规则：

- 正式知识保持 Markdown-first。
- Markdown 文档解释 asset 的用途。
- 除非 Markdown 文档明确引用，否则 AI 不应把原始资产当成 canonical prose。
- `_assets/` 不构成第三套知识系统。

## Track Knowledge Sync

当 `knowledgeSync.enabled=true` 时，每个 Codument track 都必须检查是否需要更新 docs。

> **两个时机，别只在归档**：
> - **澄清/实现期（实时）**：discuss 一旦把某概念/行为/policy/架构**澄清并稳定**，**当轮就**把它收敛进对应 owner 文档（`docs/modeling`/`docs/impl`），而不是只写进 proposal 等归档再补。这是 owner 文档保持新鲜的主路径。
> - **归档期（兜底）**：`codument-archive` 按显式 hook 对该 track 全量复查、补齐遗漏（见 `std/sop/artifact-sync.md`）。
>
> 晋升判定（落 `docs/` 还是 behaviors/decisions/memory、何时晋升）见 [knowledge-tiers.md](./knowledge-tiers.md) §4–§5。

以下变化应加入 docs sync 任务：

- domain context、object、field semantics、lifecycle、status、invariant。
- object behavior、command、query、mutation、side effect、failure semantics。
- policy、guard、permission、validation、governance rule。
- workflow 或 state transition。
- derived modeling object、policy、workflow、contract、storage relation、read model、sync flow。
- implementation architecture、framework convention、runtime convention、operations procedure。
- 未来实现者必须理解的 public contract 或 user-visible behavior。
- troubleshooting knowledge。
- 文档路径移动、拆分、合并或吸收。

每次 docs sync 应执行：

1. 判断更新属于 `docs/modeling/` 还是 `docs/impl/`。
2. 判断 plane。
3. 判断 context 或 category。
4. 判断 document role。
5. 更新最小正确文档。
6. 添加或维护 frontmatter。
7. derived modeling docs 按需维护 `derived_from`。
8. 仅在导航变化时更新 `index.md`。
9. 代码入口或测试变化时更新 `code-map.md`。
10. 路径移动或旧文档被吸收时更新 `migration-map.md`。
11. **新建目录时**按 [folder-manifest.md](@codument/std/spec/folder-manifest.md) 写"目录职责"块（自定义类目目录必填）。
12. 如果无需更新 docs，记录具体原因。

## Routing Table

> 下表用**默认类目词汇**（domain 用 objects/policies/workflows；impl 用六类）。换领域时按各 index.md 的"生成式步骤"替换类目名，路由逻辑不变。

| Change Type | Target |
|-------------|--------|
| 新增 domain term | `docs/modeling/domain/glossary.md` |
| 新增 modeling plane | `docs/modeling/<plane>/index.md` |
| 新增 modeling context | `docs/modeling/<plane>/contexts/<context>/index.md` |
| 新增 modeling object | `docs/modeling/<plane>/contexts/<context>/objects/<object>/data.md` |
| 新增 object behavior | `docs/modeling/<plane>/contexts/<context>/objects/<object>/behavior.md` |
| 跨对象 modeling rule | `docs/modeling/<plane>/contexts/<context>/policies/<policy>.md` |
| 多步骤 modeling process | `docs/modeling/<plane>/contexts/<context>/workflows/<workflow>.md` |
| 代码位置变化 | 最近的 `code-map.md` |
| 跨 plane 实现架构 | `docs/impl/global/overview/<topic>.md` |
| 跨 plane 实现规则 | `docs/impl/global/rules/<rule>.md` |
| plane 实现总览 | `docs/impl/<plane>/overview/<topic>.md` |
| 可重复实现任务 | `docs/impl/<plane>/howto/<operation>.md` |
| plane 实现规则 | `docs/impl/<plane>/rules/<rule>.md` |
| 示例 | `docs/impl/<plane>/examples/<example>.md` |
| 查询表或映射 | `docs/impl/<plane>/reference/<reference>.md` |
| 故障诊断 | `docs/impl/<plane>/troubleshooting/<issue>.md` |
| 旧文档移动或吸收 | `docs/migration-map.md` |
| 原始 SQL/script/schema/UI 材料 | `docs/_assets/...` 并由 Markdown 引用 |

## Quality Checklist

- [ ] 更新是否只属于 `docs/modeling/` 或 `docs/impl/` 其中之一？
- [ ] plane 是否正确？
- [ ] 路径是否符合该 plane 的分形语法？
- [ ] frontmatter 是否与路径一致？
- [ ] modeling docs 是否显式标明 context？
- [ ] derived modeling docs 是否按需维护 `derived_from`？
- [ ] modeling 是否使用 objects、policies、workflows，而不是临时分类？
- [ ] impl 是否使用 overview、howto、rules、examples、reference、troubleshooting，而不是临时分类？
- [ ] index 文件是否只承担导航职责？
- [ ] 代码路径是否写在 `code-map.md` 或正文中，而不是 modeling frontmatter？
- [ ] 路径移动时是否更新 `migration-map.md`？
- [ ] 非正文资产是否放在 `_assets/`？
