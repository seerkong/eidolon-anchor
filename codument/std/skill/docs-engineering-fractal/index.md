# Engineering 分形标准

> 本标准定义 `codument/engineering/` 的写作方式：长期工程知识以 XNL registry 管理，承载实现、维护、运维、参考与排障知识。它与 [docs-modeling-fractal](../docs-modeling-fractal/index.md) **用同一条递归规则**，区别只在「类目词汇」。
>
> engineering registry 规范见 [engineering-registry.md](../../spec/engineering-registry.md)。

## 1. 一句话心法

engineering 树同样是递归的「知识节点」。**不变的是递归规则，可变的是每个 plane 选的类目词汇。**

- **不变**：`plane → 类目 → 主题 → 节点`；小类目聚合在 `index.xnl`，超过 lint 阈值再拆分；一处真源、其余引用；本体不在这里，使用 `modeling://...` 引用。
- **可变**：有哪些 implementation plane；每个 plane 第一层用哪些类目。

> engineering 与 modeling 的区别：modeling 装"结构真相"，engineering 装"如何实现、维护、排障"。两边都允许不同领域长出不同目录，不写死前后端。

## 2. Plane 层

真源路径：`codument/engineering/<plane>/`。

- **`global`（推荐）**：跨 plane 的实现 / 维护知识（架构、框架约定、运维方法）。
- **其他 plane（项目按领域命名）**：`backend`、`surface`、`runtime`、`storage`、`pipelines`、`agents`、`tools`、`operations`、`control-plane`、`data-plane`……
- **本体不放这里**：domain ontology 属于 `codument/modeling/`；engineering 用 `modeling://...` 引用，不复制。

每个 plane / 类目用 `index.xnl` 的 guide/overview 节点声明边界与导航；节点 schema 见 `engineering-node-schema.md`。

## 3. 类目层 —— 类目在前、主题在后

plane 第一层放**类目**，类目下放**主题**，主题下放叶子：

```text
codument/engineering/<plane>/<category>/<topic>.xnl
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
| overview | Purpose · Mental Model · Main Components · Boundaries · Related Modeling/Engineering Docs |
| howto | When To Use · Preconditions · Steps · Verification · Rollback/Recovery · Related Rules |
| rules | Rule · Applies To · Rationale · Examples · Enforcement · Exceptions · Related Modeling Docs |
| examples | Scenario · Inputs · Walkthrough · Expected Output · Notes（大块原始数据放 `_assets/` 引用） |
| reference | Scope · Table/Map · Source Of Truth · Update Procedure（生成物说明如何重生成/校验） |
| troubleshooting | Symptoms · Likely Causes · Diagnosis · Fix · Prevention（长期 lesson 同步 project memory） |

跨 plane 的 overview/rule 放 `codument/engineering/global/...`；过程中发现的规则沉淀到 `rules/` 并互链。

## 5. 元数据（用受控精简 schema）

字段集与含义在 [model-driven-docs.md](../../attractors/model-driven-docs.md) 与 [engineering-node-schema.md](../../spec/engineering-node-schema.md) 中统一定义。engineering 侧附加约定：

- engineering 节点**可在正文写代码路径**；元数据保持稳定、低冲突，**不堆 `code_paths` / `topics` 数组**。
- 实现规则**不复制** modeling policy——使用 `modeling://<plane>/<context>/<id>` 引用，本节点只写 enforcement。

## 6. 在你自己的领域长出一个新 engineering plane（生成式步骤）

1. **定边界**：它覆盖哪个实现领域、不拥有什么（写进 plane `index.xnl` 的 guide/overview 节点）。
2. **选类目集**：默认六类，或换成领域自定义类目集。
3. **建骨架**：每个类目先写一个 `index.xnl`；主题节点增多或文件超过 lint 阈值时拆为 `<topic>.xnl`。
4. **连真源**：规则/流程若依赖建模真源，使用 `modeling://...` 引用，不复制。

## 7. 反模式

❌ plane 第一层混用「主题」和「类目」：

```text
codument/engineering/runtime/{ architecture/  howto/  state/  rules/ }   # architecture/state 是主题不是类目
```

✅ 类目在前、主题在后：

```text
codument/engineering/runtime/{ overview/  howto/  rules/  examples/  reference/  troubleshooting/ }
                     └ overview/architecture/…   └ overview/state/…
```

❌ engineering 复制 canonical modeling 真源：

```text
modeling://domain/identity/token_lifecycle                    # 真源
codument/engineering/runtime/rules/token-lifecycle.xnl        # 复制 → 错
```

✅ engineering rule 引用 modeling policy，只描述本 plane 的 enforcement。
