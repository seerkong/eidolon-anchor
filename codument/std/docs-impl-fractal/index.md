# Implementation 分形标准

## 目的

本标准定义 `docs/impl/` 的目录结构与写作规则。

所有 implementation plane 必须结构同构，包括 `global`：

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

- `global`：跨 plane 的实现与维护知识。

可选 implementation plane 由项目自定义，例如 `commands`、`runtime`、`storage`、`pipelines`、`agents`、`tools`、`operations`、`control-plane`、`data-plane`。

## `docs/impl/index.md`

用途：

- 说明 implementation knowledge system。
- 列出 implementation planes。
- 声明所有 implementation planes 使用同一套 category grammar。

模板：

```markdown
---
knowledge_system: impl
knowledge_plane: index
doc_role: guide
status: active
last_verified: YYYY-MM-DD
---

# Implementation Knowledge

| Plane | Role | When to Read |
|-------|------|--------------|
| global | Cross-plane implementation knowledge | Architecture, framework, maintenance |
| runtime | Runtime implementation knowledge | Execution, state, workers |
```

规则：

- 不在这里写所有实现细节。
- 只有 implementation plane 变化时才更新。

## Implementation Plane `index.md`

路径：

```text
docs/impl/<plane>/index.md
```

用途：

- 定义 implementation plane。
- 链接到六个标准 category folders。
- 说明什么属于这里，什么不属于这里。

模板：

```markdown
---
knowledge_system: impl
knowledge_plane: <plane>
doc_role: guide
status: active
last_verified: YYYY-MM-DD
---

# <Plane> Implementation Knowledge

## Boundary

This implementation plane owns...

## Not Owned Here

- ...

| Category | Purpose | When to Read |
|----------|---------|--------------|
| overview | Mental models and architecture | Need orientation |
| howto | Repeatable operations | Need to change or maintain |
| rules | Constraints and conventions | Need to avoid violations |
| examples | Worked examples | Need a concrete reference |
| reference | Maps and stable references | Need lookup data |
| troubleshooting | Failures and diagnosis | Need to debug |
```

规则：

- `global` 负责跨 plane 实现关注点。
- 其他 plane 负责各自 plane-specific implementation concerns。
- domain ontology 不属于这里，应链接到 `docs/modeling/`。

## `overview/`

路径：

```text
docs/impl/<plane>/overview/
```

用途：

- 建立心智模型。
- 解释该 plane 的架构、主要组成、概念方向。

适合存放：

- architecture overview
- layer overview
- runtime model overview
- repository/module overview
- major responsibility map

Topic 文件模板：

```markdown
---
knowledge_system: impl
knowledge_plane: <plane>
doc_role: guide
status: active
last_verified: YYYY-MM-DD
---

# <Topic> Overview

## Purpose

## Mental Model

## Main Components

## Boundaries

## Related Modeling Docs

## Related Implementation Docs
```

规则：

- overview 解释系统形状。
- 不写步骤流程；步骤流程写 `howto/`。
- 不堆 API/schema 明细；查询型材料写 `reference/`。

## `howto/`

路径：

```text
docs/impl/<plane>/howto/
```

用途：

- 说明维护者如何执行一个可重复任务。

适合存放：

- add a command
- create an endpoint
- migrate storage
- release a package
- add a worker
- update a tool integration
- run a maintenance operation

Operation 文件模板：

```markdown
---
knowledge_system: impl
knowledge_plane: <plane>
doc_role: howto
status: active
last_verified: YYYY-MM-DD
---

# How To <Operation>

## When To Use

## Preconditions

## Steps

1. ...

## Verification

## Rollback Or Recovery

## Related Modeling Docs

## Related Rules
```

规则：

- how-to 文档是过程型文档。
- 写 how-to 时发现规则，应把规则放到 `rules/` 并链接。
- 如果过程依赖 modeling workflow，应链接到 `docs/modeling/.../workflows/`。

## `rules/`

路径：

```text
docs/impl/<plane>/rules/
```

用途：

- 保存实现约束、约定、必须遵守的规则。

适合存放：

- framework constraints
- layering rules
- dependency rules
- naming conventions
- performance/security constraints
- API compatibility rules
- deployment/runtime guardrails

Rule 文件模板：

```markdown
---
knowledge_system: impl
knowledge_plane: <plane>
doc_role: rules
status: active
last_verified: YYYY-MM-DD
---

# <Rule Name>

## Rule

## Applies To

## Rationale

## Examples

## Enforcement

## Exceptions

## Related Modeling Docs
```

规则：

- 不要复制 modeling policies。应链接到 `docs/modeling/.../policies/`。
- implementation rules 解释某 plane 中的执行和落地。
- 跨 plane rule 放到 `docs/impl/global/rules/`。

## `examples/`

路径：

```text
docs/impl/<plane>/examples/
```

用途：

- 保存 worked examples 与 concrete samples。

适合存放：

- example command
- example endpoint
- example pipeline
- example integration
- example migration
- demo walkthrough

Example 文件模板：

```markdown
---
knowledge_system: impl
knowledge_plane: <plane>
doc_role: example
status: active
last_verified: YYYY-MM-DD
---

# <Example Name>

## Scenario

## Inputs

## Walkthrough

## Expected Output

## Notes

## Related Modeling Docs

## Related Rules
```

规则：

- example 只是示例，不是规则真源。
- 不要让 example 成为唯一规则来源。
- 如果 example 包含大量原始数据，放到 `_assets/` 并链接。

## `reference/`

路径：

```text
docs/impl/<plane>/reference/
```

用途：

- 保存查询型材料和稳定映射。

适合存放：

- code maps
- API references
- schema references
- configuration references
- compatibility tables
- command option tables
- route maps
- generated-output explanations

Reference 文件模板：

```markdown
---
knowledge_system: impl
knowledge_plane: <plane>
doc_role: reference
status: active
last_verified: YYYY-MM-DD
---

# <Reference Name>

## Scope

## Table Or Map

## Source Of Truth

## Update Procedure

## Related Docs
```

规则：

- reference 优化查询，不承担叙事。
- 如果 reference 是生成物，应说明如何重新生成或验证。
- 如果 reference 映射旧路径到新路径，优先使用根级 `docs/migration-map.md`。

## `troubleshooting/`

路径：

```text
docs/impl/<plane>/troubleshooting/
```

用途：

- 保存故障模式、诊断、修复指导。

适合存放：

- common build failures
- runtime errors
- data corruption symptoms
- deployment issues
- integration failures
- user-visible incident diagnosis

Issue 文件模板：

```markdown
---
knowledge_system: impl
knowledge_plane: <plane>
doc_role: troubleshooting
status: active
last_verified: YYYY-MM-DD
---

# <Issue Name>

## Symptoms

## Likely Causes

## Diagnosis

## Fix

## Prevention

## Related Incidents Or Memory

## Related Modeling Docs
```

规则：

- troubleshooting 文档必须具体、可诊断。
- 如果问题沉淀出长期 lesson，应考虑同步 project memory。
- 如果问题改变规则，应更新 `rules/`。

## Bad Patterns

Bad：implementation plane 第一层混用主题和分类。

```text
docs/impl/runtime/
  architecture/
  howto/
  state/
  rules/
```

Use：

```text
docs/impl/runtime/
  overview/
  howto/
  rules/
  examples/
  reference/
  troubleshooting/
```

Bad：implementation docs 复制 canonical modeling truth。

```text
docs/modeling/domain/contexts/identity/policies/token-lifecycle.md
docs/impl/runtime/rules/token-lifecycle.md
```

implementation rule 应引用 modeling policy，并只描述 enforcement。
