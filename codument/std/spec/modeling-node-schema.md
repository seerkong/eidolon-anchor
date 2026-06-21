# modeling 节点 schema 规范（std/spec/modeling-node-schema.md）

> 定义 `codument/modeling/` 里**一个节点长什么样**：kind 谱系、表征形式、每个 kind 的最小必备表征、命名空间 id。融合 DEPA 四维 + 事实源、modeling 实证、多表征 DSL。
>
> 载体见 `modeling-registry.md`；delta 见 `modeling-delta.md`。
>
> XNL 语法权威见 [std/spec/xnl-format.md](./xnl-format.md)。

## 1. 一句话心法

> 节点 = **有 id、多表征、可 XNL 寻址的领域结构节点**。越靠建模内核越用 DEPA 跨领域概念（裸名 kind）；越靠 shell/展示/交互越落到命名空间领域 kind。

## 2. kind 谱系（内核裸名 → shell 命名空间）

| 层 | kind 标签 | 最小必备表征 | DEPA / 来源 |
|---|---|---|---|
| 内核（裸名，跨领域） | `entity` / `object` | `types` + `fact_grade` + `single_writer` + invariants | Data / 事实源； `objects/data.md` |
| | `enum` | `types` | Data |
| | `state-machine` | `mermaid` + 状态枚举 | Data/Processor； `workflows` |
| | `module` / `capsule` | `depends_on` + capsule-tree（**到文件/符号级**，见 §2.1） | Effect / 边界；`Module` |
| | `component` | `runtime`/`input`/`config`/`output` 四个 `types` 块 + ctrl/rule/dataflow `pseudo` | DEPA 标准组件；`Procedure` |
| | `port` | 入口签名 + `command\|message` 标注 | Actor/Processor；泛化 HttpEndpoint/Kafka |
| | `actor` | 单写边界 + 偏重(data-owner/执行/组合) + 解环决策 | DEPA actor-paradigm |
| | `policy` | rule `pseudo`(datalog/switch) 或引用 `behavior://` | 跨对象； `policies` |
| shell（命名空间，领域定） | `surface:route` `backend:endpoint` `cli:command` `agent:tool` … | 各 plane 自定义 | route/command/action 本就跨领域 |

> kind 词汇的“内核裸名 vs 命名空间领域”区分 Layer-1 的 Extension kind 谱系：通用概念裸名共用，领域概念加命名空间前缀。

> **shell kind 节点的写法（重要）**：表里的 `surface:route` / `backend:endpoint` / `cli:command` 等**带冒号的命名空间 kind 是 `kind` 属性的值，不是 XNL 元素标签名**。XNL 元素标签名**禁含冒号**（写进标签名会触发 XNL 语法错 `Expected metadata key`）。落到 XNL 时：元素标签用普通词（`<endpoint>` / `<route>` / `<command>`），命名空间 kind 放进 `kind` 属性。
> - ✅ `<endpoint #orders.place_order kind="backend:endpoint">` / `<route #shop.checkout kind="surface:route">`
> - ❌ `<backend:endpoint #orders.place_order kind="backend:endpoint">`（标签名含冒号 → XNL 语法错）
> 详见 §7 Good/Bad。

### 2.1 capsule-tree 必须到文件/符号级（不止 contract/logic/support）

`module`/`capsule` 的 capsule-tree **只列 contract/logic/support/ports 四目录是无效建模**——那是套路，不含信息。必须再下探一层，列出**每个 capsule 下的具体文件（或符号）+ 一句职责 + 它实现/投影的建模节点（`#id` 或 `modeling://…`）**。判据：读 capsule-tree 就能知道每个文件干嘛、依赖谁、是纯逻辑还是 IO 边界。

```
orders/
  contract/
    order-create.ts      # OrderCreate / CartLine 入参 DTO（无副作用）
    order-response.ts     # OrderResponse ← modeling://domain/orders/order 只读投影
  logic/
    project-total.ts      # fn(lines)->total（derived_projection_cache，纯）
    transit-status.ts     # 状态迁移守卫，依据 #orders.order_lifecycle
  support/
    order-store.ts        # append/load order 事件（authoritative_fact 写口，IO）
    inventory-mailbox.ts  # 向 #inventory.inventory 投递 message
  ports/
    create-order.ts       # POST /orders -> #orders.place_order（message）
```

> 完整示例见测试资源 `test/resources/modeling-showcase/base/domain/orders/module.xnl`。

## 3. 表征形式（多表征，TextElement 零转义）

> 下表只给按例小抄；XNL `TextElement`（`?marker` 文本块）等完整语法以 [std/spec/xnl-format.md](./xnl-format.md) 为准。

| 表征 | XNL 写法 | 装什么 |
|---|---|---|
| desc | `<desc ?>…</?>` | 语义 / businessDesc / 边界 |
| types | `<types ?m>…</?m>` | TypeScript 类型 / 枚举 / 签名（Data + component IO） |
| mermaid | `<mermaid ?m>…</?m>` | ER / state / module-relation / sequence |
| pseudo | `<pseudo kind="ctrl\|rule\|dataflow" ?m>…</?m>` | 控制流 / 规则(datalog·switch) / 数据流 |
| 结构 metadata | 节点属性 | `kind` `fact_grade` `single_writer` `depends_on` `visibility` `derived_from` |
| 边界 | `<not-owned-here ?>` | 与相邻 context 易混时必写 |

> **component 四块的写法（canonical）**：`component` 的 runtime / input / config / output **用裸标签** `<runtime>` / `<input>` / `<config>` / `<output>`（每块内部仍用 `types` 表征装类型/签名）——这是**推荐的 canonical 形式**。
> - ✅ canonical：`<runtime ?r>…</?r>` / `<input ?i>…</?i>` / `<config ?c>…</?c>` / `<output ?o>…</?o>`
> - ⚠️ 兼容：`validate` 也接受 `<types role="runtime">`（及 `role="input"`/`"config"`/`"output"`）这类 role 写法作兼容（accepted-but-discouraged），但**裸标签为推荐形式**，新建模请用裸标签。
> 完整 Good 示例见 §7。

## 4. 事实源（DEPA，entity 必备）

- `fact_grade` 取 7 级之一：`authoritative_fact` / `domain_canonical_event` / `runtime_control_fact` / `append_only_journal` / `checkpoint_snapshot` / `derived_projection_cache` / `surface_view`。
- `single_writer` = 该事实的唯一写入者；衍生节点用 `<fact-source>` 说明“谁是源、谁是只读投影、不反写”。

## 5. id 命名空间（允许多级）

- 用 XNL `XnlWord` 的多级命名空间：`#<context>.<name>`（如 `#resource.skill_tool`），或跨 plane 时 `#<plane>.<context>.<name>`（如 `#domain.resource.skill_tool`）= `namespace[...] + name`，全局唯一。
- 命名空间层级 = 寻址路径层级，类似 `命名空间::类名`；同一 context 内可省略 plane 前缀，跨 plane 引用用全限定。
- mutation 按 id 命中（`metadataIdMode:"identity"`）。

## 6. 跨文档引用（VFS URI + scheme 自识别）

节点之间、以及节点指向 behaviors 的引用，统一用 **VFS URI** 作 canonical 语法：

- modeling 节点 → `modeling://<plane>/<context>/<name>`（绝对、自描述；文件移动/分形拆分后引用不失效，因为指逻辑节点非文件路径）。
- 行为契约 → `behavior://<capability>/requirements/<id>`。
- 与 codument 既有 `behavior://`/`decision://`/`spec://` 同族，一套心智。

**解析规则：scheme 自识别**——解析器扫节点所有 metadata/attribute 值，**凡值匹配已知 VFS scheme（`modeling://` / `behavior://` / …）即视为引用并解析**，其余是字面量。不需要固定 key 白名单（scheme 本身标明“这是引用”）。

约定可读 key（**仅约定，不强制**，靠 scheme 解析）：

| key | 在哪种节点 | 值 |
|---|---|---|
| `depends_on` | module/capsule | `[ modeling://… ]` 列表 |
| `derived_from` | derived plane 节点 | `modeling://…`（单一父来源） |
| `single_writer` | entity | `modeling://…`（owning module/actor） |
| `uses` | component / 字段 | `[ modeling://… ]`（引用的 entity/enum） |
| `behaviors` | policy / behavior 节点 | `[ behavior://… ]` |

> 注意区分：`fact_grade` 是**枚举值**（authoritative_fact…），不是引用，保持字面量；`single_writer` 是**引用**，用 `modeling://`。
>
> `<Import as="X" src="vfs://...">`（xnl-import）是**可选语法糖**（想要短别名 / 整包导入时用）；绝对 URI 始终可用，不依赖 import 声明即可解析。

## 7. Good / Bad

Good（entity，最小必备齐）：
```xnl
<object #resource.skill_tool kind="entity" fact_grade="authoritative_fact" single_writer="resource.store" [
  <desc ?>聚合型资源…</?>
  <types ?t>interface SkillTool { key: string; status: SkillToolStatus }
  enum SkillToolStatus { Draft="draft", Online="online" }</?t>
  <state-machine #resource.skill_tool_status [ <mermaid ?m>
  stateDiagram-v2
    draft --> online: publish
  </?m> ]>
  <fact-source ?>唯一写入者 resource.store；file_contents 只读投影不反写。</?>
]>
```

Good（component，四块裸标签 — canonical）：
```xnl
<component #orders.place_order_proc kind="component" [
  <desc ?>下单组件：校验库存、落账、投递通知。</?>
  <runtime ?r>type Runtime = { clock: Clock; orderStore: OrderStore }</?r>
  <input ?i>interface PlaceOrderInput { cartId: string; userId: string }</?i>
  <config ?c>interface PlaceOrderConfig { maxLines: number }</?c>
  <output ?o>interface PlaceOrderOutput { orderId: string; total: number }</?o>
  <pseudo kind="ctrl" ?p>validate(input) -> reserve(stock) -> append(order) -> notify</?p>
]>
```

Good（shell kind 节点 — 普通标签 + `kind` 属性）：
```xnl
<endpoint #orders.place_order kind="backend:endpoint">
<route #shop.checkout kind="surface:route">
```

Bad：
- ❌ entity 缺 `fact_grade`/`single_writer`/`types`（缺最小必备 → lint 不过）。
- ❌ 把可测 BDD case 复述进 modeling（应放 behaviors，modeling 引用 `behavior://`）。
- ❌ desc/types 用 XML 转义（应用 `TextElement ?marker` 零转义）。
- ❌ module 缺 `depends_on`/capsule-tree（无法判依赖成环 → actor 决策）。
- ❌ 用 `surface:route` 表达本应是内核 `entity` 的领域对象（kind 选错层）。
- ❌ shell kind 把命名空间 kind 写进**元素标签名**：`<backend:endpoint #orders.place_order kind="backend:endpoint">`（标签名含冒号 → XNL 语法错 `Expected metadata key`）。正确：标签用普通词 `<endpoint … kind="backend:endpoint">`，冒号只出现在 `kind` 属性值里。
- ❌ component 四块写成 `<types role="runtime">…</types>`（等）当作唯一表征——虽 `validate` 兼容接受，但**非 canonical**；应写裸标签 `<runtime>`/`<input>`/`<config>`/`<output>`。
- ❌ component 四块用 **marker 名**编码角色 `<types ?runtime>…</?runtime>`——marker 是节点的免转义 id、**不承载语义角色**，`validate` **不**接受这种写法；必须用裸标签 `<runtime>` 或（兼容）`<types role="runtime">`。

## 8. modeling vs behaviors

- 可测 BDD 契约（requirement/suite/case，given/when/then）→ `codument/behaviors/`。
- 结构/类型/状态机/依赖/事实源/分发策略 → `codument/modeling/`。
- modeling 的 behavior/policy 节点引用 `behavior://…`，不重复。

## 9. 语言约定（描述用中文，代码标识符用英文）

modeling 节点的**描述性内容一律用中文**，**代码标识符保持英文**：

- **中文**：`<desc>` / `<fact-source>` / `<not-owned-here>` / `<dependency-rule>` / `<invariants>` 等散文块；`<types>` 与 IO 块（`<runtime>`/`<input>`/`<config>`/`<output>`）里的**代码注释**（`// …`）；`<pseudo>` 的自然语言步骤；`<mermaid>` 的节点/迁移**标签文字**；capsule-tree 里每个文件的职责注释。
- **英文**：TypeScript `interface`/`type`/字段名、`enum` 成员名与值、`kind` 值、`fact_grade` 枚举、metadata key、`#id` 命名空间（`<plane>.<context>.<name>`）、VFS scheme（`modeling://`/`behavior://`）；mermaid 状态名若对应 enum 值（如 `draft`/`done`）保持英文。

> 原因：描述用中文便于团队阅读理解；代码标识符 / 枚举 / id 是**机器契约**，须英文以保证生成的 TS 可编译、与 schema 校验及跨文档引用一致。

Good（注释/描述中文，标识符英文）：
```xnl
<component #orders.place_order kind="component" [
  <desc ?>下单组件：校验购物车、预留库存、落账。</?>
  <runtime ?r>
  interface PlaceOrderRuntime {
    orderStore: OrderStore       // 订单写入口（副作用契约）
    inventory: InventoryMailbox  // 跨 actor 的 message 投递口
  }
  </?r>
  <pseudo kind="ctrl" ?p>校验 input → 经 message 预留库存 → 落账 → 发布事件</?p>
]>
```

Bad：
- ❌ `<desc>`/`<fact-source>` 等描述写英文（应中文）。
- ❌ 把 `interface`/字段名/`enum` 值/`#id`/`kind` 改成中文（破坏代码可用性与机器契约）。
