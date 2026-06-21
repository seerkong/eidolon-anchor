# Implementation 分形标准

> 本标准定义 `docs/impl/` 的写作方式。它与 [docs-modeling-fractal](../docs-modeling-fractal/index.md) **用同一条递归规则**，区别只在「类目词汇」。
>
> 共享内容（节点不变量、frontmatter、根布局、同名文件夹演化、迁移台账、track 同步）见 [model-driven-docs.md](../../attractors/model-driven-docs.md)。本文件只讲 **impl 侧特有**的约定。

## 1. 一句话心法

impl 树同样是递归的「知识节点」。**不变的是递归规则，可变的是每个 plane 选的类目词汇。**

- **不变**：`plane → 类目 → 主题 → 叶子`；每层 `index.md` 只导航；一处真源、其余引用；本体不在这里，引用 `docs/modeling/`。
- **可变**：有哪些 implementation plane；每个 plane 第一层用哪些类目。

> impl 与 modeling 的唯一区别：modeling 装"业务真源"，impl 装"如何实现与维护"。两边都允许不同领域长出不同目录，不写死前后端。

## 2. Plane 层

路径：`docs/impl/<plane>/`（所有实现知识都在 `docs/impl/` 下，不散到根层）

- **`global`（推荐）**：跨 plane 的实现 / 维护知识（架构、框架约定、运维方法）。
- **其他 plane（项目按领域命名）**：`backend`、`surface`、`runtime`、`storage`、`pipelines`、`agents`、`tools`、`operations`、`control-plane`、`data-plane`……
- **本体不放这里**：domain ontology 属于 `docs/modeling/`；impl 用链接引用，不复制。

每个 plane / 类目目录的 `index.md` 顶部带「目录职责」块（标准类目一行精简型，自定义类目完整型）——见 [folder-manifest.md](@codument/std/spec/folder-manifest.md)。

## 3. 类目层 —— 类目在前、主题在后

plane 第一层放**类目**，类目下放**主题**，主题下放叶子：

```text
docs/impl/<plane>/<category>/<topic>/<leaf>.md
```

### 推荐默认类目（强烈建议作为起点）

对**大多数可维护系统**通用，先用这六类，缺哪类就不建：

| 类目 | 装什么 | 何时读 |
|------|--------|--------|
| overview | 心智模型、架构、组成 | 需要建立方向感 |
| howto | 可重复的维护操作（加接口、迁移、发布……） | 要动手改/维护 |
| rules | 实现约束、约定、护栏 | 要避免越界 |
| examples | worked example / 样例 | 要一个具体参照 |
| reference | code map、API/schema/配置表、映射 | 要查表 |
| troubleshooting | 故障模式、诊断、修复 | 要排障 |

### 这只是默认，不是法律

如果你的领域维护工作**不这样分解**，就在 plane 第一层换成你自己的类目集。**不变量是「类目在前、主题在后 + 每个类目语义单一」，不是这六个名字。** 例如：

```text
数据平台运维：  runbooks/  pipelines/  slas/  incidents/  dashboards/
硬件 / 固件：    bringup/   drivers/   timing/  rma/        bench/
```

## 4. 叶子写作要点（按类目选自然小节）

每个类目的叶子用对应小节即可，不强制统一模板：

| 类目 | 建议小节 |
|------|----------|
| overview | Purpose · Mental Model · Main Components · Boundaries · Related Modeling/Impl Docs |
| howto | When To Use · Preconditions · Steps · Verification · Rollback/Recovery · Related Rules |
| rules | Rule · Applies To · Rationale · Examples · Enforcement · Exceptions · Related Modeling Docs |
| examples | Scenario · Inputs · Walkthrough · Expected Output · Notes（大块原始数据放 `_assets/` 引用） |
| reference | Scope · Table/Map · Source Of Truth · Update Procedure（生成物说明如何重生成/校验） |
| troubleshooting | Symptoms · Likely Causes · Diagnosis · Fix · Prevention（长期 lesson 同步 project memory） |

跨 plane 的 overview/rule 放 `docs/impl/global/...`；过程中发现的规则沉淀到 `rules/` 并互链。

## 5. Frontmatter（用受控精简 schema）

字段集与含义在 [model-driven-docs.md](../../attractors/model-driven-docs.md) 统一定义。impl 侧附加约定：

- impl 文档**可在正文写代码路径**；frontmatter 保持稳定、低冲突，**不堆 `code_paths` / `topics` 数组**。
- 实现规则**不复制** modeling policy——链接到 `docs/modeling/<plane>/contexts/<ctx>/policies/...`，本文件只写 enforcement。

## 6. 在你自己的领域长出一个新 impl plane（生成式步骤）

1. **定边界**：它覆盖哪个实现领域、不拥有什么（写进 plane `index.md` 的 Boundary / Not Owned Here）。
2. **选类目集**：默认六类，或换成领域自定义类目集。
3. **建骨架**：`index.md`(导航) + 各类目目录；类目→主题→叶子，叶子先单文件，太大再升级同名文件夹。**每个类目目录给其 `index.md` 写「目录职责」块**（自定义类目必填，见 [folder-manifest.md](@codument/std/spec/folder-manifest.md)）。
4. **连真源**：规则/流程若依赖建模真源，链接到 `docs/modeling/.../{policies,workflows}/`，不复制。

## 7. 反模式

❌ plane 第一层混用「主题」和「类目」：

```text
docs/impl/runtime/{ architecture/  howto/  state/  rules/ }   # architecture/state 是主题不是类目
```

✅ 类目在前、主题在后：

```text
docs/impl/runtime/{ overview/  howto/  rules/  examples/  reference/  troubleshooting/ }
                     └ overview/architecture/…   └ overview/state/…
```

❌ impl 复制 canonical modeling 真源：

```text
docs/modeling/domain/contexts/identity/policies/token-lifecycle.md   # 真源
docs/impl/runtime/rules/token-lifecycle.md                            # 复制 → 错
```

✅ impl rule 引用 modeling policy，只描述本 plane 的 enforcement。
