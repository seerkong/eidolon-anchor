# Docs Knowledge Attractor

## 目的

当 `knowledgeSync.enabled=true` 时，本文件是项目知识维护的入口 attractor。

文档系统由两套并列的分形标准组成：

```text
docs/modeling/  # 建模真源与派生建模
docs/impl/      # 实现、操作、示例、参考、排障知识
```

创建或更新 docs 前，必须先阅读 Codument 标准目录中的详细标准：

- [codument/std/docs-modeling-fractal/index.md](../std/docs-modeling-fractal/index.md)：`docs/modeling/` 的规范标准。
- [codument/std/docs-impl-fractal/index.md](../std/docs-impl-fractal/index.md)：`docs/impl/` 的规范标准。

本文件只保留路由规则、通用元数据、track 同步检查清单。不要把具体建模文件模板或实现平面细则塞回本文件；这些内容应维护在两份分形标准中。

## 真源边界

保持这些真源互相分离：

- `codument/specs/`：能力契约注册表，面向行为 case 与测试生成。
- 源码、测试、配置：可执行真源。
- `docs/modeling/`：规范化建模真源与派生建模。
- `docs/impl/`：实现与运维知识。
- `codument/decisions/`：从 track 局部决策中提升出的长期决策。
- `codument/memory/`：长期 lessons、incidents、patterns、summaries。

`docs/` 不应复制全部 spec 或全部代码。它保存的是本体、心智模型、派生设计、实现指导、运维知识，以及让 AI 从知识进入代码的 code map。

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

## 通用 Frontmatter

每份正式 Markdown 文档都应以 frontmatter 开头。

```yaml
---
knowledge_system: modeling
knowledge_plane: domain
doc_role: canonical
status: active
context: <context>
last_verified: YYYY-MM-DD
---
```

字段含义：

- `knowledge_system`：`modeling` 或 `impl`。
- `knowledge_plane`：平面名，例如 `domain`、`runtime`、`command`、`global`、`storage`。
- `doc_role`：`canonical`、`derived`、`guide`、`rules`、`howto`、`example`、`reference`、`troubleshooting`、`compat`、`legacy`。
- `status`：`active`、`draft`、`compat`、`legacy`、`deprecated`。
- `context`：建模上下文或实现主题，按需填写。
- `derived_from`：派生建模文档基于 canonical 建模文档时必须填写。
- `canonical_source`：compat/legacy 文档指向的 canonical 来源。
- `last_verified`：最后一次与源码/事实核对的日期。

规则：

- modeling 文档不应在 frontmatter 中写 `code_paths`。代码路径写在 `code-map.md` 或正文中。
- impl 文档可以在正文中写代码路径。frontmatter 应保持稳定、低冲突。
- 文档路径与 frontmatter 语义必须一致。

## Modeling System

`docs/modeling/` 包含所有建模平面。所有 modeling plane 必须同构：

```text
docs/modeling/<modeling-plane>/
  index.md
  glossary.md
  contexts/
    index.md
    <context>/
      index.md
      code-map.md
      objects/
      policies/
      workflows/
```

必需 modeling plane：

- `domain`：canonical domain ontology。

可选 derived modeling plane 由项目自定义，例如 `runtime`、`command`、`api`、`storage`、`pipeline`、`agent`、`tool`、`integration`。

完整模板与文件级写作规则见 [docs-modeling-fractal/index.md](./docs-modeling-fractal/index.md)。

## Implementation System

`docs/impl/` 包含所有实现平面。所有 implementation plane 必须同构，包括 `global`：

```text
docs/impl/<implementation-plane>/
  index.md
  overview/
  howto/
  rules/
  examples/
  reference/
  troubleshooting/
```

必需 implementation plane：

- `global`：跨实现平面的实现与维护知识。

可选 implementation plane 由项目自定义，例如 `commands`、`runtime`、`storage`、`pipelines`、`agents`、`tools`、`operations`、`control-plane`、`data-plane`。

完整模板与文件级写作规则见 [docs-impl-fractal/index.md](./docs-impl-fractal/index.md)。

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
11. 如果无需更新 docs，记录具体原因。

## Routing Table

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
