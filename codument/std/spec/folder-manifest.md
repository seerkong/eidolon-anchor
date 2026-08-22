# 外部文档目录职责自描述（std/spec/folder-manifest.md）

> 本规范只适用于输出到项目 `docs/` 等位置的 Markdown 文档制品。`codument/modeling/` 与 `codument/engineering/` 是 XNL registry，不创建 Markdown `index.md`，其目录和节点职责分别由 registry/node schema 定义。
>
> 外部 artifact definition 决定目录树、默认类目和分发目标；本规范只定义 Markdown 文档树中可选的就地职责块。层级与晋升语义见 [std/attractors/knowledge-tiers.md](@codument/std/attractors/knowledge-tiers.md)。

## 1. 目录职责块（写在该目录的 `index.md` 里）

每个**标准化文件夹**的 `index.md`，在 H1 标题下方紧跟一个**目录职责块**。两种规模：

**精简型（一行 blockquote，多数叶子类目用）**：

```markdown
# <Folder> ...

> 目录职责 · holds: <一句话：装什么> · excludes: <一句话：不装什么> · tier: stable|dated · ⬆from: <晋升来源> · ⬇to: <晋升去向>
```

**完整型（plane / context / 根这种结构节点用）**：

```markdown
## 目录职责

- **holds**：本目录拥有……
- **excludes**：不属于这里的（去向）……
- **tier**：`stable`（就地改）| `dated`（带日期记录）
- **promotes_from**：上游来源层（哪些信息晋升到这里）
- **promotes_to**：下游去向层（这里稳定后再晋升到哪）
```

字段语义（全部对齐 [knowledge-tiers.md](@codument/std/attractors/knowledge-tiers.md)）：

| 字段 | 含义 | 缺省 |
|---|---|---|
| `holds` | 该文件夹**装什么**（一句话边界）；标准文件夹可引用 artifact 默认类目语义 | 必填 |
| `excludes` | **不**装什么 + 应去哪（防止相邻目录混淆） | 相邻易混时必填 |
| `tier` | `stable`=owner 文档就地改；`dated`=带日期、归档不可变 | 必填 |
| `promotes_from` / `promotes_to` | 晋升阶梯上的上下游边 | 知识层目录必填；纯导航目录可省 |

> 这是**受控小块**，不是又一份 frontmatter。不要把真源正文塞进职责块——职责块只声明"边界与晋升边"，导航仍走 index 表格。

## 2. 标准文件夹 vs 自定义文件夹

- **标准文件夹**（外部文档制品约定的默认类目）：职责可继承对应 artifact 规则，职责块写一行即可。
- **自定义文件夹**（某业务领域自己长出来的类目，如 `sources/transforms/sinks`、`runbooks/slas`）：artifact 默认规则无法预知，所以必须自带完整型职责块。

> 规则：artifact policy 要求目录自描述时，任何不在其默认词汇表内的目录都必须有职责块；否则视为未声明。

## 3. 补齐机制（backfill / 补齐）

目标：不必预先在中心文件枚举所有目录；缺声明的由机制扫描补上。**幂等**——只补缺失，不覆盖人工已写的块（除非显式确认）。

步骤：

1. **扫描**：遍历 `docs/`（及按需的知识层目录），对每个含 `index.md` 的目录检查是否有合法职责块。
2. **判缺**：列出 (a) 缺职责块的目录；(b) 非默认词汇却无完整型块的自定义目录；(c) 职责块与实际内容/位置不符的目录。
3. **生成**：对每个缺口，从下列来源合成职责块——
   - 目录**名 + 在外部 docs 树中的位置** → 套 artifact 的默认类目语义；
   - 目录**实际内容**（已有哪些文件/子目录）→ 收敛 holds/excludes；
   - [knowledge-tiers.md](@codument/std/attractors/knowledge-tiers.md) → 定 `tier` 与 `promotes_from/to`；
   - 推断不确定时**标 TODO/uncertainty，不臆造**；自定义目录语义模糊时提请人工确认。
4. **写回**：把生成的精简/完整型块插到该目录 `index.md` H1 下；新增/改动登记到 `docs/migration-map.md` 若涉及路径。

触发点：
- **artifact authoring**：首次生成外部 Markdown 文档树时，为每个目录补齐职责块。
- **artifact-sync**：同步新建外部 docs 目录时，由显式 artifact 规则决定是否写职责块。
- **validate**：作为一致性检查项（缺块 / 块与内容不符 → 报告）。

## 4. 与中心声明的关系

职责声明现在有两处，**就近优先**：

- **就地（权威）**：各目录 `index.md` 的职责块——单一事实、独立可配。
- **中心（导航）**：[knowledge-tiers.md](@codument/std/attractors/knowledge-tiers.md) 的分层表给"有哪些层、晋升怎么走"的总览；它**不**逐个枚举叶子目录。

冲突时以**就地职责块**为准（它离真源最近）；中心表只在分层/晋升语义上兜底。

## 5. 示例

标准叶子（继承默认，一行）：

```markdown
# Resource Objects

> 目录职责 · holds: resource context 的对象数据/行为真源 · excludes: 跨对象规则(→policies/) · tier: stable · ⬆from: track design 稳定后 · ⬇to: 代码/测试投影
```

自定义类目（必须完整型）：

```markdown
# Transforms

## 目录职责
- **holds**：数据管道领域里"转换"算子的建模真源（输入/输出 schema、语义、副作用）。
- **excludes**：数据源(→`sources/`)、落地(→`sinks/`)、调度(→`schedules/`)。
- **tier**：`stable`
- **promotes_from**：track 中该管道的 proposal/design 稳定部分
- **promotes_to**：源码/测试（瞬时投影）
```
