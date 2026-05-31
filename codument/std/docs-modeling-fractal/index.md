# Modeling 分形标准

## 目的

本标准定义 `docs/modeling/` 的目录结构与写作规则。

所有 modeling plane 必须结构同构：

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
        index.md
        <object>/
          data.md
          behavior.md
      policies/
        index.md
        <policy>.md
      workflows/
        index.md
        <workflow>.md
```

`domain` 是必需 plane，表示 canonical ontology。其他 modeling plane 由项目自定义，表示 derived modeling plane，例如 `runtime`、`command`、`api`、`storage`、`pipeline`、`agent`、`tool`、`integration`。

## Plane 语义

`docs/modeling/domain/`：

- 拥有 canonical business/conceptual ontology。
- 定义 domain objects、behaviors、policies、workflows、vocabulary。
- 不依赖 derived plane。

`docs/modeling/<derived-plane>/`：

- 将 domain concepts 投影到某个具体建模视角。
- 可表示 command model、runtime model、storage model、API model、pipeline model、agent/tool model 或其他项目自定义模型。
- 基于 domain truth 派生时，必须通过 `derived_from` 引用来源。
- 不得复制 canonical domain truth 形成第二份真源。

## `docs/modeling/index.md`

用途：

- 说明 modeling system。
- 列出 modeling planes。
- 声明所有 modeling planes 使用同一套分形语法。

模板：

```markdown
---
knowledge_system: modeling
knowledge_plane: index
doc_role: guide
status: active
last_verified: YYYY-MM-DD
---

# Modeling

| Plane | Role | When to Read |
|-------|------|--------------|
| domain | Canonical ontology | Need concepts, objects, policies, workflows |
| runtime | Runtime projection | Need execution model |
```

规则：

- 不在此文件写 context 详情。
- 只有 modeling plane 新增、删除、改名或重分类时才更新。

## Modeling Plane `index.md`

路径：

```text
docs/modeling/<plane>/index.md
```

用途：

- 定义该 plane 的职责。
- 说明该 plane 是 canonical 还是 derived。
- 链接到 `glossary.md` 与 `contexts/index.md`。

模板：

```markdown
---
knowledge_system: modeling
knowledge_plane: <plane>
doc_role: guide
status: active
last_verified: YYYY-MM-DD
---

# <Plane> Modeling

## Role

This plane owns...

## Relation To Other Planes

- Canonical source:
- Derived consumers:

| Document | Purpose | When to Read |
|----------|---------|--------------|
| glossary.md | Plane terminology | Terms are ambiguous |
| contexts/index.md | Context entry | Need context-level truth |
```

规则：

- `domain` 必须说明自己是 canonical。
- derived plane 必须说明自己代表什么投影，以及 canonical source 在哪里。
- 不在这里嵌入所有 context 详情。

## Modeling Plane `glossary.md`

路径：

```text
docs/modeling/<plane>/glossary.md
```

用途：

- 定义该 plane 使用的术语。
- 消除别名、旧名、近义词歧义。
- 将术语链接到 context 与 canonical docs。

模板：

```markdown
---
knowledge_system: modeling
knowledge_plane: <plane>
doc_role: canonical
status: active
last_verified: YYYY-MM-DD
---

# <Plane> Glossary

## <Term>

Definition.

- Context:
- Aliases:
- Not the same as:
- Canonical docs:
```

规则：

- `domain` 中的 glossary term 是 canonical。
- derived plane 中的 glossary term 如果派生自 domain term，应指回 domain term。
- 术语必须精确，不要把 glossary 写成完整设计文档。

## Modeling Plane `contexts/index.md`

路径：

```text
docs/modeling/<plane>/contexts/index.md
```

用途：

- 列出该 modeling plane 中的 contexts。
- 说明每个 context 在该 plane 中的职责。
- 展示与其他 modeling plane 的对齐关系。

模板：

```markdown
---
knowledge_system: modeling
knowledge_plane: <plane>
doc_role: guide
status: active
last_verified: YYYY-MM-DD
---

# <Plane> Contexts

| Context | Responsibility In This Plane | Related Domain Context | When to Read |
|---------|------------------------------|------------------------|--------------|
| <context> | ... | docs/modeling/domain/contexts/<context>/ | ... |
```

规则：

- context 名称通常应跨 plane 对齐。
- 如果 derived plane 暂时没有某个 domain context 的投影，可以省略，也可以建立薄 context 并明确说明当前没有独立投影。
- 不要为了对称伪造不存在的 derived concepts。
- 不要在这里复制 object/policy/workflow 内容。

## Modeling Context Directory

路径：

```text
docs/modeling/<plane>/contexts/<context>/
```

必需结构：

```text
index.md
code-map.md
objects/
  index.md
policies/
  index.md
workflows/
  index.md
```

用途：

- context 是 modeling plane 的主要边界。
- context 拥有该 plane 中的 objects、policies、workflows、code map。

### Context `index.md`

模板：

```markdown
---
knowledge_system: modeling
knowledge_plane: <plane>
doc_role: guide
status: active
context: <context>
derived_from:
  - docs/modeling/domain/contexts/<context>/index.md
last_verified: YYYY-MM-DD
---

# <Context> Context

## Boundary

This context owns...

## Not Owned Here

- ...

## Plane Role

In this modeling plane, this context represents...

## Objects

| Object | Purpose | When to Read |
|--------|---------|--------------|

## Policies

| Policy | Purpose | When to Read |
|--------|---------|--------------|

## Workflows

| Workflow | Purpose | When to Read |
|----------|---------|--------------|

## Code Map

- code-map.md
```

规则：

- `domain` context 省略 `derived_from`。
- derived plane context 与 domain context 对齐时，应填写 `derived_from`。
- `Boundary` 必须写。
- 相邻 context 容易混淆时，必须写 `Not Owned Here`。
- index 负责导航和边界说明，不承载全部真源。

## Modeling `objects/`

路径：

```text
docs/modeling/<plane>/contexts/<context>/objects/
```

用途：

- object 是该 plane 中有名字的概念单元。
- 在 `domain` 中，它们是 domain objects。
- 在 derived plane 中，它们是 projection objects，例如 command objects、runtime objects、storage aggregates、API resources、pipeline entities、tool models、integration resources。

`objects/index.md` 模板：

```markdown
---
knowledge_system: modeling
knowledge_plane: <plane>
doc_role: guide
status: active
context: <context>
last_verified: YYYY-MM-DD
---

# <Context> Objects

| Object | Data | Behavior | Source |
|--------|------|----------|--------|
| <object> | <object>/data.md | <object>/behavior.md | ... |
```

规则：

- 每个 object 都应有 `data.md` 和 `behavior.md`。
- 当 object 目录只有 `data.md` 与 `behavior.md` 时，object 级 `index.md` 可省略。
- 不要把字段或行为真源写进 `objects/index.md`。

## Object `data.md`

路径：

```text
docs/modeling/<plane>/contexts/<context>/objects/<object>/data.md
```

用途：

- 定义 plane object 的结构与关系语义。
- 解释意义，而不是只复制字段、类型、表结构或 DTO。

模板：

```markdown
---
knowledge_system: modeling
knowledge_plane: <plane>
doc_role: canonical
status: active
context: <context>
derived_from:
  - docs/modeling/domain/contexts/<context>/objects/<source-object>/data.md
last_verified: YYYY-MM-DD
---

# <Object> Data

## Identity And Boundary

What this object is. What it is not.

## Structure

Object-level structure and field groups.

## Field Semantics

### Identity Fields

- `id`: ...

### Ownership Fields

- ...

### State Fields

- ...

### Configuration Fields

- ...

### Audit Fields

- ...

## Relationships

How this object relates to other objects or contexts.

## States

Allowed stable states and their meaning.

## Invariants

Rules that must always hold.

## Compatibility And Aliases

Legacy fields, aliases, deprecated names, migration notes.
```

规则：

- domain object 使用 `doc_role: canonical`，并省略 `derived_from`。
- derived plane object 如果基于 domain object，必须填写 `derived_from`。
- 字段按语义分组，不按存储顺序机械罗列。
- 必须解释 identity、ownership、lifecycle、status、redundancy、synchronization、compatibility。
- 如果某字段只是实现细节且没有建模意义，应明确说明。

Bad：

```markdown
- status: string
- owner_id: number
```

Good：

```markdown
- `status`: lifecycle marker. `draft` means editable; `published` means externally visible.
- `owner_id`: ownership boundary used for access checks and uniqueness scope.
```

## Object `behavior.md`

路径：

```text
docs/modeling/<plane>/contexts/<context>/objects/<object>/behavior.md
```

用途：

- 定义 plane object 的行为与消息语义。

模板：

```markdown
---
knowledge_system: modeling
knowledge_plane: <plane>
doc_role: canonical
status: active
context: <context>
derived_from:
  - docs/modeling/domain/contexts/<context>/objects/<source-object>/behavior.md
last_verified: YYYY-MM-DD
---

# <Object> Behavior

## External Messages

Messages or operations visible outside the object/context/plane.

## Internal Command / Query / Mutation

Internal command, query, mutation, calculation, reconstruction semantics.

## Preconditions And Guards

Required conditions before behavior may execute.

## State Transitions

How behavior changes state.

## Side Effects

Effects on other objects, contexts, derived models, events, storage, versions.

## Failure Semantics

Invalid inputs, missing prerequisites, conflict handling, diagnostics.

## Idempotency And Concurrency

Repeat calls, conflict detection, locking, ordering, consistency.
```

规则：

- domain object behavior 是 canonical。
- derived plane object behavior 是投影行为，应引用 canonical source。
- actor/message 思想体现在这里，不体现在目录名。
- 不要把 behavior 降级为 API endpoint 实现说明。

## Modeling `policies/`

路径：

```text
docs/modeling/<plane>/contexts/<context>/policies/
```

用途：

- policy 是某个 modeling plane 中跨 object 或跨 behavior 的规则。
- `domain` 中的 policy 是 canonical。
- derived plane 中的 policy 描述投影层约束，并在派生自 domain policy 时引用来源。

Policy 文件章节：

```markdown
# <Policy Name>

## Rule

## Scope

## Rationale

## Enforcement Points

## Exceptions

## Failure Semantics
```

规则：

- domain policy 通常省略 `derived_from`。
- derived policy 不应完整重写 domain policy 正文；应引用并说明投影差异。
- 跨 object guard 放在 policy，不要强行塞入单个 object，除非它只影响该 object。

## Modeling `workflows/`

路径：

```text
docs/modeling/<plane>/contexts/<context>/workflows/
```

用途：

- workflow 是某个 modeling plane 中的多步骤过程。
- `domain` 中的 workflow 表达 canonical lifecycle 或业务流程。
- derived plane 中的 workflow 表达投影流程，例如 command execution、runtime state transitions、storage update flows、pipeline stages、agent/tool interaction flows。

Workflow 文件章节：

```markdown
# <Workflow Name>

## Trigger

## Participants

## Preconditions

## Steps

## State Changes

## Side Effects

## Failure And Recovery

## Postconditions
```

规则：

- domain workflow 保持 domain-level。
- derived workflow 保持 plane-level。
- 单 object 消息链接到 object behavior。
- guard 与治理规则链接到 policies。

## Modeling `code-map.md`

路径：

```text
docs/modeling/<plane>/contexts/<context>/code-map.md
```

用途：

- 连接 modeling docs 与源码/测试。
- 帮助 AI 从建模知识继续进入实现。

章节：

```markdown
# <Context> Code Map

## Source Roots

## Key Entry Points

## Tests

## Generated Or External Sources

## Notes For AI
```

规则：

- 代码路径写正文，不写 modeling frontmatter。
- 不在 code map 中复制 modeling rules。
- source roots、entrypoints、tests 移动时必须更新。
