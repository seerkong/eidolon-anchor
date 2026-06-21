# 目录职责自描述与补齐（std/spec/folder-manifest.md）

> 解决一个问题：分形 docs **不应强依赖一份中心规范**去说明"每个标准文件夹装什么"。每个文件夹应能在**自己**的 `index.md` 里**独立声明**职责；不同业务领域长出的自定义文件夹也能自带说明。本规范定义这套**自描述格式**，以及一个**补齐（backfill）机制**给缺失的文件夹补上声明。
>
> 它与 [docs-*-fractal](@codument/std/docs-modeling-fractal/index.md) 互补：分形 index 给"递归规则 + 默认类目词汇"；本规范给"每个具体文件夹**就地**钉死它装什么"。层级与晋升语义见 [attractors/knowledge-tiers.md](@codument/attractors/knowledge-tiers.md)。

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

字段语义（全部对齐 [knowledge-tiers.md](@codument/attractors/knowledge-tiers.md)）：

| 字段 | 含义 | 缺省 |
|---|---|---|
| `holds` | 该文件夹**装什么**（一句话边界）；标准文件夹可引用分形默认类目语义 | 必填 |
| `excludes` | **不**装什么 + 应去哪（防止相邻目录混淆） | 相邻易混时必填 |
| `tier` | `stable`=owner 文档就地改；`dated`=带日期、归档不可变 | 必填 |
| `promotes_from` / `promotes_to` | 晋升阶梯上的上下游边 | 知识层目录必填；纯导航目录可省 |

> 这是**受控小块**，不是又一份 frontmatter。不要把真源正文塞进职责块——职责块只声明"边界与晋升边"，导航仍走 index 表格。

## 2. 标准文件夹 vs 自定义文件夹

- **标准文件夹**（分形默认类目：modeling 的 `objects/policies/workflows`、impl 的 `overview/howto/rules/...` 等）：职责可**继承分形默认**，职责块写一行即可（甚至只写与默认的差异）。
- **自定义文件夹**（某业务领域自己长出来的类目，如 `sources/ transforms/ sinks/`、`runbooks/ slas/`）：分形规范**无法预知**，所以**必须**自带完整型职责块——这正是"允许在某个文件独立进行说明配置"的落点。

> 规则：**任何不在分形默认词汇表内的目录，其 `index.md` 必须有职责块**；否则视为未声明，补齐机制会标记。

## 3. 补齐机制（backfill / 补齐）

目标：不必预先在中心文件枚举所有目录；缺声明的由机制扫描补上。**幂等**——只补缺失，不覆盖人工已写的块（除非显式确认）。

步骤：

1. **扫描**：遍历 `docs/`（及按需的知识层目录），对每个含 `index.md` 的目录检查是否有合法职责块。
2. **判缺**：列出 (a) 缺职责块的目录；(b) 非默认词汇却无完整型块的自定义目录；(c) 职责块与实际内容/位置不符的目录。
3. **生成**：对每个缺口，从下列来源合成职责块——
   - 目录**名 + 在树中的位置** → 套分形默认类目语义；
   - 目录**实际内容**（已有哪些文件/子目录）→ 收敛 holds/excludes；
   - [knowledge-tiers.md](@codument/attractors/knowledge-tiers.md) → 定 `tier` 与 `promotes_from/to`；
   - 推断不确定时**标 TODO/uncertainty，不臆造**；自定义目录语义模糊时提请人工确认。
4. **写回**：把生成的精简/完整型块插到该目录 `index.md` H1 下；新增/改动登记到 `docs/migration-map.md` 若涉及路径。

触发点：
- **docs-bootstrap**：首次建分形 docs 时，为每个目录补齐职责块。
- **artifact-sync**：归档同步**新建**目录时，顺手为新目录写职责块。
- **validate**：作为一致性检查项（缺块 / 块与内容不符 → 报告）。

## 4. 与中心声明的关系

职责声明现在有两处，**就近优先**：

- **就地（权威）**：各目录 `index.md` 的职责块——单一事实、独立可配。
- **中心（导航）**：[knowledge-tiers.md](@codument/attractors/knowledge-tiers.md) 的分层表给"有哪些层、晋升怎么走"的总览；它**不**逐个枚举叶子目录。

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
