# L1 元公理 · XNL 语法层

> 这些公理直接源自 XNL 语法本身的特性，与任何领域无关。当前由 depa-flows 的 Flow DSL 遵守。
> 编号 `M-S*`（Meta-Syntax）。

## M-S1 · 节点四段形态

XNL 节点完整形态：`<Tag #id 元数据 { 属性 } ( 单件段 ) [ 列表段 ]>`。各成分语义固定：

| 成分 | 承载 | 语法特性 |
|---|---|---|
| `Tag` | 节点类别 | 决定该节点如何被解释（见 M-S2） |
| `#id` | 节点身份 | 解析为 `Word{namespace, name}`，可点分（见 naming-axioms） |
| 元数据位 `key=value` | 系统级元信息 | 紧跟 tag/`#id` 之后、`{ }` 之前；承载 `apiVersion`/`version` 等系统级元数据，与业务属性分离 |
| `{ ... }` | 属性键值对 | 标量/内联结构数据（业务属性） |
| `( ... )` | 唯一的**子域概念** | 每种子域概念只出现一次；重复条目由该子域的复数容器承载 |
| `[ ... ]` | 直接、有序或可重复子节点 | 同 tag 可重复 |

`( ... )` 与 `[ ... ]` 顺序无关、各至多一次，可与 `{ ... }` 共存。

## M-S2 · `()` 是子域，`[]` 是直接条目

`()` 不只是“不会重复的子节点”容器；它表达父节点拥有的**唯一子域概念**。同一个子域概念在 `()` 中只能出现一次。子域中若有多个同类条目，使用该概念的复数容器及其 `[]`：

```xnl
<If #choose (
  <Branches [
    <Branch #active {
      when = "vfs://./flow-code/route.ts#isActive"
    } [
      <Return #done { value = "active" }>
    ]>
    <Otherwise [
      <Return #fallback { value = "inactive" }>
    ]>
  ]>
)>
```

- `()`：`Branches`、`FlowContract`、`EffectBindings`、`Scope` 这类每父节点唯一的子域。
- `[]`：元素、语句、图节点、分支条目等父节点的直接顺序或可重复事实。
- 禁止为“凑层级”引入没有领域语义的 `<Block>`、`<Nodes>` 包装；根直接条目直接进入根 `[]`。

`()` 的 tag 去重是这一规则的语法保护，而不是把所有“单件节点”塞进去的理由。

## M-S3 · tag 形态决定解析路径

一个 DSL 应当让 **tag 的书写形态自身**携带"这个节点怎么解释"的信息，读者与 parser 无需查上下文：

| tag 形态 | 约定含义 |
|---|---|
| 小写裸词（`h1`、`div`） | 宿主原生/透传节点 |
| PascalCase 保留字 | DSL 结构节点（codec 白名单） |
| 点分限定名（`a.b.C`） | 注册表查找（引用其他定义） |

具体每档映射到什么由领域层（L2）定；L1 只规定"形态分档"这条元规则。

## M-S4 · 单件/列表段的物理可拆分性

因为 `()` 里的节点是父节点的唯一子域，它可以**无损地外提为独立文件**（文件根节点 = 子域节点本身）；`[]` 则承载该域的集合或直接条目。这条语法性质是“单文件 ⟷ 多文件同构”（见 naming-axioms M-N6）的语法基础：内联子域与拆出文件根**完全同型**，互转不改变语义或引用。

## M-S5 · 集合与属性使用空白分隔，禁止逗号

XNL 不是 JSON。`[]` 数组项、`{}` 属性与内联 object 字段都以空白或换行分隔，禁止写逗号：

```xnl
outputs = ["items" "sourceStatus"]
inputs = { items = "flow-port://#collect/items" sourceStatus = "flow-port://#collect/sourceStatus" }
```

`["items", "sourceStatus"]` 与 `{ items = "...", sourceStatus = "..." }` 都是 parse error。生成 manifest 前必须对整个 candidate 检查并移除 JSON 风格分隔符。
