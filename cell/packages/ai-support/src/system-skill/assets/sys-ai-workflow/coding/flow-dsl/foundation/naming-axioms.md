# L1 元公理 · 命名、寻址与制品组织

> 与领域无关的命名/引用/文件组织公理。任何基于 XNL 的 bundle 化 DSL 都遵守。编号 `M-N*`（Meta-Naming）。

## M-N1 · 内容为真源，路径只是布局

节点的身份、类别一律来自**文件内容**（根节点 tag + `#id`），绝不来自文件名或目录名。文件路径只是物理布局，可自由重组而不改变语义。

推论：每个容器（一个可加载的制品、一个多文件单元）有且只有一个**入口清单**，统一命名 `manifest.xnl`。清单内根节点的 tag 决定容器类别，`#id` 决定容器身份。不允许用文件名编码类别（禁止 `page.xnl`/`component.xnl` 这类 kind-named 入口）。

## M-N2 · 域组织与 entry 寻址分投影

域名、文件名与域根 tag 描述**制品组织**；URI scheme 描述域内被引用的**单个 entry**。两者有关联但不做字符串机械等同：集合/复数词、facet 点分词、PascalCase tag 都不应泄漏进 scheme。

```text
domain/file/root tag:  commands / commands.xnl / <Commands>
entry URI scheme:      command://#users.search

domain/file/root tag:  config.def / config.def.xnl / <ConfigDef>
entry URI scheme:      config-def://#users.search
```

scheme 必须是单数 kebab-case，并符合：

```text
^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$
```

`.` 可以留在 domain/file facet、FQN 与 `#id` 中，但不得出现在 scheme。每个 domain 到 entry scheme 的映射必须在其领域规范中显式登记。不可因为名称相近而臆造新 scheme。

## M-N3 · def / seed 是域的 facet

任何域 `X` 可以带两个伴生 facet：

- `X.def` — 描述 X 的**类型/形状**。
- `X.seed` — 描述 X 结构的**初始数据**。
- `X` 本身 — 当前声明/数据。

facet 是完整的域（独立文件、独立 entry scheme、独立节点），按 M-N2 分投影，与主域成对出现、允许缺省。这样“一个事物的类型”和“它的初值”用统一后缀表达，不为每种事物发明专属命名。

## M-N4 · 统一 URI 引用

一切跨节点引用是 URI，写在引号字符串里，分三类：

| 类 | 形态 | 寻址 | 例 |
|---|---|---|---|
| 物理 | `vfs://…` | 文件（`@/` 工作区根、`./` 当前目录、`../` 父目录） | `"vfs://@/shared/prefabs.xnl"`、`"vfs://./adapters/core.ts"` |
| 逻辑 | `<域名>://…` | 域内节点（默认容器私有，见领域层的私有性规则） | `"config://#api"`、`"config-def://#users-page"` |
| 注册表 | `<注册表名>://…` | 由制品结构派生的具名注册表（如单元表、路由表） | `"page://org.app.UsersPage"`、`"route://#users-route"` |

URI 三种寻址形态：

```text
<scheme>://<path>            层级路径寻址             "route://reports/:id"
<scheme>://#<id>             节点 id 寻址（域内唯一）   "scope://#users-filter"
<scheme>://#<id>/<sub-path>  锚定 id 后走结构路径       "config://#users-filter/keywordInput"
```

逐条展开：

- **`#id` 寻址**是最常用形态：定位某域中 `#id` 节点本身。`"config://#api"` = config 域里 `<ConfigEntry #api>` 整个节点。
- **`#id/<sub-path>` 寻址**在锚定节点后继续走**属性结构**：`"config://#api/baseUrl"` = `<ConfigEntry #api { baseUrl = "/api" }>` 里的 `baseUrl` 值；多级用 `/` 连（`"config://#users-filter/keywordInput/placeholder"`）。
- **`<path>` 寻址**用于本身有层级结构的域（如路由树按 path 匹配：`"route://reports/:id"`）。

分隔符职责固定：**`.` 只做名字空间分隔**（FQN 段、域 facet 段），**`-` 连接 scheme 中的多个词**，**`/` 只做结构层级分隔**。对比：`"config-def://#users-page"` 中 `-` 是 scheme 词间连接，`"config://#api/baseUrl"` 中 `/` 是下钻一层属性——两个符号永不互换职责。

scheme 集合 = 明确登记的 domain-entry 映射 + 注册表名 + `vfs`。**引用必须写在引号字符串里**——`:` 不是 XNL identifier 字符，裸写 `ref = config://#x` 是语法错误。

### 解析边界

URI 解析必须先确定"从哪个容器看出去"：

- **逻辑 scheme 默认在当前容器内解析**：`"config://#api"` 命中的是当前 app / page / component 自己的 config 域，不会按全局搜索去找同名节点。
- **跨容器引用必须经显式通道**：要么经注册表 scheme 引用某个具名制品整体（如 `page://<FQN>`、`component://<FQN>`），要么经 `vfs://` import 共享文件。不要用逻辑 scheme 偷穿到别的容器内部。
- **注册表 scheme 的可见性由领域层定义**：L1 只规定它是结构派生的具名表；哪些注册表存在、键是什么、暴露何种公共契约，由 L2/L3 定。

这条规则把"容器内部事实"与"可复用公共制品"分开：逻辑 URI 是私有域内引用，注册表 URI 是公开入口引用，物理 URI 是文件引用。

## M-N5 · FQN 身份

可跨容器复用的定义用**点分限定名（FQN）**作全局身份（`org.pkg.Name`，类比包名+类名）。FQN 写在定义根节点的 `#id` 上；引用处用 FQN 作 tag（M-S3 的点分档）或经注册表 scheme（M-N4）。FQN 与它所在的文件路径**相互独立**（M-N1）——移动文件不改 FQN，改文件名不影响引用。

## M-N6 · 单/多文件同构

一个容器/单元支持两种物理形态，语义完全等价（语法基础见 M-S4）：

- **单文件**：域内联为 `( ... )` 区段节点 + 一个列表主体段。
- **多文件**：`manifest.xnl` 薄清单 + 每域一个 `<域名>.xnl` 文件；启用哪些域由**文件内容**（各域文件的根节点 tag）发现，不在清单上声明（M-N1 内容为真源）。

单→多文件化是纯机械重构：`(...)` 区段节点原样搬进独立文件，所有引用零改动（M-N4 的逻辑寻址不感知物理布局）。

## M-N7 · 节点二相：内联定义 or `ref` 引用

**每一个节点都有两种可互换的写法**，语义等价，任选其一：

1. **内联定义**——把节点的属性/子节点直接写在原地。
2. **`ref` 引用**——写一个**空壳 + `ref` 属性**，采用别处（同类型）已定义的节点：`<Scope ref="users-page">` 采用预定义的 `<Scope #users-page {…}>`。

`ref` 的值有两种形态，按目标位置选：
- **按名**（同域预定义）：`ref="users-page"` —— 采用当前域内 `#users-page` 的定义。
- **按 URI**（需要显式定位时）：`ref="scope://#users-page"` —— 用 M-N4 的 URI 定位；是否允许跨容器取决于 M-N4 的解析边界与领域层私有性规则。

铁律（消除"Ref 又 ref"）：
- **引用属性名统一为 `ref`**，不为每种节点发明 `xxxRef`（`scopeRef`/`contractRef`/`commandRef`…全部退役）。一个节点要引用什么，由它的 **tag** 表明（`<Scope ref=…>` 引用的必是 scope，`<Command ref=…>` 引用的必是 command），无需在属性名里重复类别。
- **不套包装节点**。要引用一个 command 或 event，写 `<Command ref="…">` / `<Event ref="…">`，**不是** `<MessageRef ref="…">`——后者用一个专门的"引用节点"去指向消息，是 tag 已能表达类别时的冗余（Ref 又 ref）。任何 `XxxRef` 包装 tag 都退役。
- **域绑定字段例外**：一个节点内**多个**指向不同域的绑定（如 Scope 绑定 config），用**裸名字段 + URI 值**（`config = "config://#x"`），因为它们是本节点的属性而非"采用另一个同类节点"。区别：`ref` 是"我就是那个节点"，绑定字段是"我引用那个域的资源作为我的一个属性"。复杂依赖绑定（如 effect 实现）优先放入节点的 `()` 子区段。

**按 id 隐式关联**（第三种、免 `ref` 的手法）：当定义与使用天然同 id 时，定义域中 `#foo` 的条目**自动**作用于结构中的 `#foo`，使用处连 `ref` 都不必写。用于契约↔元素这类一一对应关系。

三种手法并排对照（同一个 Scope 的三种到位方式）：

```xnl
# 预定义（在 scopes 域里）
<Scope #users-page { config = "config://#users-page" }>

# ① 内联定义 —— 属性直接写在使用处，不进域
<Capsule #ad-hoc ( <Scope { config = "config://#ad-hoc" }> )>

# ② ref 引用 —— 空壳 + ref，采用预定义
<Capsule #users-filter ( <Scope ref="users-page"> )>

# ③ id 隐式关联（适用于契约类）—— 定义域 <ElementContract #users-filter> 自动作用于
#    树中 #users-filter 元素，使用处什么都不写
```

更多例子：

```xnl
# ref 采用：Accepts/Sends 中这个节点本身就是一个 Command 或 Event
<Accepts [ <Command ref="command://#users.refresh"> ]>
<Sends [ <Event ref="event://#users.selected"> ]>

# 域绑定字段：Route 不是 Page；只是把 page 字段绑定到某个 Page 注册表条目
<Route #users-route { path = "/users" page = "page://dg.admin.basic.UsersPage" }>

# 物理引用：FuncEffect 不是采用另一个 FuncEffect 节点；只是把 type 字段绑定到代码类型入口
<FuncEffect #users.query { type = "vfs://./effects/users.effects.ts#UsersQueryEffect" }>
```

目标：同一份数据只有一处真源；"定义"与"引用"用 `ref` 的有无区分；类别用 tag 表达，不靠属性名或包装节点。

## M-N8 · 数据自持

一个节点的静态描述数据**内联在该节点上**（不寄存到别的域再引回来）。域之间只用引用表达**归属/绑定**关系，不表达数据搬运。

**裸值 vs 引用的分界**（判据只有一条：这份数据归谁所有）：

- **归本节点所有的静态描述 → 内联裸值**。
- **指向其他节点的归属/绑定 → 引用**（M-N7 的 `ref` 或裸名 URI 字段）。
- 一个数据只在一处为真源。

```xnl
# ✅ 正：effect binding 的类型入口归 binding 自己所有 —— 内联在节点属性上
<FuncEffect #users.query {
  type = "vfs://./effects/users.effects.ts#UsersQueryEffect"
}>

# ❌ 反：把 effect binding 的类型入口寄存到 config 域，再从 binding 引回来 —— 寄存链
<ConfigEntry #effect-code { usersQuery = "vfs://./effects/users.effects.ts#UsersQueryEffect" }>
<FuncEffect #users.query { type = "config://#effect-code/usersQuery" }>
```

反例的问题：`type` 的真源漂到了 config 域（config 应只装静态开关/枚举/常量预设），读者要跨两个域拼出 binding 的全貌；改类型入口要去 config 改、但语义归属在 binding——职责错位。凡出现“A 的数据躺在 B 域、C 再引用回来”的链条，都违反本条。

## M-N9 · 配置皆声明式 XNL

制品内不允许 JSON/XML/YAML 等第二套配置入口——一切配置是 XNL（M-N2 的统一性前提）。可执行代码不是配置：纯函数脚本（`.ts` 等）以文件形式存在、经引用挂接（见 depa-axioms M-D3），但绝不内联进 XNL。
