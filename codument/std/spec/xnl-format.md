# XNL 数据格式（大模型版）
XNL（Extensible Notation Language）
用于提示大语言模型理解与生成新版短标签的 XNL（Extensible Notation Language）。语法沿用 XML 风格起始标签，但闭合极简，便于对话/提示场景快速书写。

## 核心语法速览
- 开始标签：`<name metadata... sections...>`；`metadata` 是语法层名字，不代表所有节点属性都应该放这里。
- 元数据：`key=value` 紧跟在标签名后，可有多个，存入 `metadata`。
- 属性块：`{ key = value ... }` → 存入 `attributes`。
- 数组块：`[ item1 item2 <child> ]` → 存入 `body`（元素可为值或子节点）。
- 唯一子节点块（extend）：`( <child1> <child2> )` → 存入 `extend`，同名覆盖旧值并警告，保持出现顺序。
- 文本块：`<name metadata {attr} ?marker> ... </?marker>`，允许 metadata/`{}`，禁止 `[]`/`()`；标记可选但必须首尾一致。
- 无其它块时直接以 `>` 结束节点。

## metadata 与 attributes 的语义边界

XNL 有两套键值承载位：标签头部的 `metadata` 与 `{}` 属性块的 `attributes`。除非场景规范明确另有约定，**普通节点属性必须写进 `{}` 属性块**；`metadata` 只放系统级、控制面、解析/合并内部需要的配置。

- ✅ 普通节点属性：`kind`、`role`、`fact_grade`、`single_writer`、`depends_on`、`status`、`priority`、`confidence`、`applies_to`、`related` 等业务/知识/决策属性，写在 `{}` 里。
- ✅ 系统级 metadata：解析器或工具链需要在节点业务属性之外读取的控制字段，例如 legacy `metadata.id` 兜底、vfs/vcs/diff/apply/merge 的专属字段、临时合并引擎的身份/冲突控制字段。
- ✅ 稳定节点 id 优先使用 XNL `#id` word（如 `<decision #track.foo { ... }>`），不要把常规 id 当普通属性塞进 metadata。
- ⚠️ 历史文件中可能仍有 `<node kind="...">` 这类 legacy metadata 写法；新写法应改为 `<node { kind = "..." }>`。

## extend `()` 与 body `[]` 的语义边界

XNL 的 `()` 与 `[]` 也不是随意替换的“子节点容器”：

- ✅ `()` extend block：承载**单例语义槽位**，也就是一个节点内按语义最多出现一次的子节点，如 `question`、`recommendation`、`answer`、`decision-text`、`rationale`、`evidence`、`source-of-truth` 等。解析时同名子节点后者覆盖前者并产生重复警告，正好适合“唯一槽位”。
- ✅ `[]` body array：承载**同类集合 / 有序列表**，如多个下级 `decision`、多个 `case`、多段同类 item、数组值、混合列表等。
- ❌ 不要把所有子节点都无脑放进 `[]`。如果某个子节点是“这个节点的唯一说明/答案/理由”，应放进 `()`。
- ❌ 不要把下级 tree 节点塞进 `()`。树的 child collection 是集合语义，应放进 `[]`。

决策 DSL 的额外边界：

- `decision` 自身的 `[]` **只承载下级 `<decision>`**，表示决策树关系。
- 备选方案必须放在 decision 的 `()` 中唯一出现的 `<options>` 下；`<options>` 自己的 `[]` 才承载多个 `<option>`。
- 当前 XNL 解析器对“只有数组块的包装节点”要求显式空属性块，因此写作 `<options { } [...]>`；`{ }` 只是语法占位，不承载业务属性。
- `<option>` 的 `()` 承载唯一的 `<title>`、`<description>`、`<tradeoff>` 等说明槽位，不把多个 option 平铺进 decision 的 `()`。
- 带选项的新决策点必须在 `<options>` 中标记恰好一个 `recommended = true`。
- `<answer>` 是 decision 唯一的回答反馈容器；原始回答使用 `<raw-answer>`，整理后的 `<decision-text>`、`<rationale>`、`<evidence>` 都放在 `<answer>` 下。

决策树示例：

```xnl
<decision #track.foo.root {
  status = "pending"
  priority = "P0"
  blocks = ["design.md"]
}
(
  <question ?>是否采用 decisions.xnl？</?>
  <recommendation ?>采用；legacy decisions.md 只读兼容。</?>
  <options { } [
    <option { key = "A" recommended = true }
    (
      <title ?>采用 decisions.xnl</?>
      <description ?>新建 track/mission 使用 XNL 保存结构化决策。</?>
      <tradeoff ?>需要同步 CLI、模板和历史兼容逻辑。</?>
    )
    >
    <option { key = "B" }
    (
      <title ?>继续使用 decisions.md</?>
      <description ?>继续通过 Markdown 标题和列表记录决策。</?>
      <tradeoff ?>迁移成本低，但结构化读取和集成能力较弱。</?>
    )
    >
  ]>
  <answer { }
  (
    <raw-answer ?>待确认。</?>
    <decision-text ?>待确认。</?>
    <rationale ?>待补充。</?>
    <evidence ?>用户要求将过程决策结构化。</?>
  )
  >
)
[
  <decision #track.foo.child {
    status = "accepted"
    priority = "P1"
  }
  (
    <question ?>是否保留 legacy fallback？</?>
    <answer { }
    (
      <raw-answer ?>保留。</?>
      <decision-text ?>保留 legacy decisions.md 读取兼容。</?>
      <rationale ?>避免破坏历史资产。</?>
      <evidence ?>已有历史 track 使用 decisions.md。</?>
    )
    >
  )
  >
]>
```

示例：

```xnl
<decision #track.add_help_gate.upgrade_workspace_help {
  priority = "P0"
  status = "accepted"
  blocks = ["track.xml" "implementation" "tests"]
}
(
  <question ?>upgrade-workspace --help 是否必须短路且无副作用？</?>
  <answer { }
  (
    <raw-answer ?>是。</?>
    <decision-text ?>所有子命令都必须支持 -h/--help，且 help 必须无副作用。</?>
    <rationale ?>避免查看帮助时误触发高副作用操作。</?>
    <evidence ?>用户曾遇到 upgrade-workspace --help 误触发升级。</?>
  )
  >
)
>
```

## 字面量与节点
- `ValueLiteral` 仅包含：字符串（单双引号，支持 `\\`、`\"`、`\'`、`\n`、`\t`、`\r`）、布尔、null、数值（保留整数/浮点种类）。
- 对象值：`{ key = value ... }`，键可为标识符或引号字符串；`value` 可以是任意 `XnlNode`（值、对象、数组、元素、注释）。
- 数组值：`[ ... ]`，元素是 `XnlNode`，因此数组/对象/属性可嵌入完整的子标签结构或值。
- `metadata`/`attributes`/`body` 同样以 `Record<string, XnlNode>` 或 `XnlNode[]` 表示，可混合值与子元素。
- 无表达式 `(expr)` 或原始 `<(raw)>` 语义；括号仅用于 extend 块。

## 结构与约束
- 文本块不能与 `[]` 或 `()` 同时出现；可带 metadata 与 `{}`。
- extend 块必须全是子节点；同名覆盖旧值并产生 `DUPLICATE_CHILD` 警告。
- 对象/数组/属性值可混合值与标签；当需要唯一子节点语义仍应使用 `()`。
- 注释 `<!-- ... -->` 可出现在节点间、块内、文本块中；解析时跳过（文本块会移除注释内容）。
- 多行文本去缩进：去掉首行空行，然后按结束 `</#...>` 行左侧缩进去除前缀（空格/Tab）。

## EBNF 摘要
```ebnf
Document    = S? Node* ;
Node        = TextNode | Element | VoidNode ;
Element     = "<" Name Metadata? Sections ">" ;
VoidNode    = "<" Name Metadata? ">" ;
TextNode    = "<" Name Metadata? AttributeBlock? "?" TextMarker? ">" TextContent "</?" TextMarker? ">" ;

Metadata    = (S Attribute)* ;
Attribute   = Key S? "=" S? ValueLiteral ;
Key         = Name | String ;

Sections    = (AttributeBlock | ArrayBlock | ExtendBlock)+ ;
AttributeBlock = "{" MapEntries "}" ;
ArrayBlock  = "[" ArrayItems "]" ;
ExtendBlock = "(" ExtendChildren ")" ;

MapEntries  = (S? MapEntry S?)* ;
MapEntry    = Key S? "=" S? ValueLiteral ;
ArrayItems  = (S? (ValueLiteral | Node) S?)* ;
ExtendChildren = (S? Node S?)* ; (* child tag names unique; later wins with warning *)

ValueLiteral = Literal | ObjectLiteral | ArrayLiteral ;
ObjectLiteral = "{" (S? MapEntry (S MapEntry)*)? S? "}" ;
ArrayLiteral  = "[" (S? ValueLiteral (S ValueLiteral)*)? S? "]" ;

Literal     = Boolean | Null | Number | String | IdentifierString ;
Boolean     = "true" | "false" ;
Null        = "null" ;
Number      = Integer | Float ;
String      = DoubleString | SingleString ;
IdentifierString = IdentifierStart IdentifierChar* ;
TextMarker  = IdentifierString ;
```

## 类型定义
```typescript
export type NumericKind = "Integer" | "Float";

export interface StringValue {
  kind: "String";
  value: string;
}

export interface BooleanValue {
  kind: "Boolean";
  value: boolean;
}

export interface NullValue {
  kind: "Null";
}

export interface NumberValue {
  kind: "Number";
  value: number;
  numericKind: NumericKind;
  raw: string;
}

export type ValueLiteral = StringValue | BooleanValue | NullValue | NumberValue;

export interface ObjectValue {
  kind: "Object";
  entries: Record<string, XnlNode>;
}

export interface ArrayValue {
  kind: "Array";
  items: XnlNode[];
}

export type AttributeMap = Record<string, XnlNode>;

export interface ExtendBody {
  order: string[];
  children: Record<string, ElementNode>;
}

export interface ElementNode {
  name: string;
  metadata: AttributeMap;
  attributes?: AttributeMap;
  body?: XnlNode[];
  extend?: ExtendBody;
  text?: string;
  textMarker?: string;
}

export interface CommentNode {
  type: "Comment";
  value: string;
}

export type ContainerNode = ArrayValue | ObjectValue | ElementNode;

export type XnlNode = ValueLiteral | ContainerNode | CommentNode;

```

## 示例
```xnl
<doc [
  <no_body_node1>
  <no_body_node2 a=[1] b={c=3}>
  <system_metadata_demo1 xnl_tool="demo" {
    a = 'abc'
    b = "tt\t\n"
    c = { inner = 2 }
    "string as key" = 2.3
    'string as key2' = 3.4
  }>
  <list_body1 [
    1 2 <item id="x" count=3 active=true note="hi">
  ]>
  <has_extend1 (
    <a {v=1}>
    <a {v=2}> <!-- 覆盖前一个 a，产生 DUPLICATE_CHILD 警告 -->
  )>
  <has_extend2 (
    <abc {
      a = [1 2]
      b = {c = 3}
    }>
    <efg [
      1
      <b>
    ]>
  )>
  <mixed_1 {
    a = 1
  } [
    1
    [2 3]
    <tt>
  ] (
    <abc {
      a = [1 2]
      b = {c = 3}
    }>
    <efg [
      1
      <b>
    ]>
  )>
  <text1 xnl_tool="demo" {b="zh"} ?>
    在纯文本内部，无需转义，例如 & < > #
    可以包含形如 <notatag 的内容，均按文本处理
    多行文本会按结束标签所在行的缩进去除前缀
  </?>
  <text2 xnl_tool="demo" {b="cc"} ?flag_1234>
    如果文本中包含 `</?>` 字样，可在开始标签后加标记，如 `?flag_1234`
    结束标签必须使用相同标记 `?flag_1234`
  </?flag_1234>
]>
```

## 生成检查清单
- 文本块用 `<name ... ?marker?> ... </?marker?>`，不与 `[]`/`()` 同用；metadata 与 `{}` 可放在 `?` 前。
- 普通节点属性写 `{}`；metadata 只放系统级字段。
- 单例语义槽位写 `()`；同类集合 / 下级树节点写 `[]`。
- extend 块只写子节点，同名覆盖并警告；需要多个同名请改用数组块。
- 键名若含空格/特殊字符请加引号；字符串可用单/双引号。
- 注释可写，但会被忽略；文本内注释也会被移除。


## ❌ 常见错误示例

**闭合标签类型不匹配**是最容易犯的错误！开始标签的类型必须与结束标签的类型严格对应
**使用了xml的闭合标签规则**是其次最容易犯的错误！虽然看起来类似，但是实际内部结构和xml有极大的不同

### 闭合标签不匹配
#### ❌ 错误示例

```xnl
<SetVariable id="SetVariable-a" {
  name="SetVariable"
  assignTo = "sum"
]>  ❌ 错误！`{` 对应 `}`，不是 `]`
```

#### ✅ 正确示例

```xnl
<SetVariable id="SetVariable-a" {
  name="SetVariable"
  assignTo = "sum"
}>  ✅ 正确！ `{` 对应 `}`
```

### 文本节点使用了xml的结束标签规则
#### ❌ 错误示例1

```xnl
<div id="" ?>
</div> ❌ 错误！文本标签的结束，如果没有自定义marker，应当用`</?>`，不是 `</div>`
```

#### ❌ 错误示例2

```xnl
<div id="" ?>
</?>
</div> ❌ 错误! 前面已经通过</?>，闭合了标签，不能再添加类似xml的结束标签
```

#### ✅ 正确示例

```xnl
<div id="" ?>
</?>
```


### 文本节点自定义的marker不匹配
#### ❌ 错误示例

```xnl
<my_text id="" ?ttt>
  content
</?qqq>
❌ 错误！文本标签的结束，如果有marker，应当与开始节点一致`</?ttt>`，不能是其他marker，例如本例中错误的 `</?qqq>`
```

#### ✅ 正确示例

```xnl
<my_text id="" ?ttt>
  content
</?ttt>
```


### 元素标签名含冒号
XNL 元素标签名**禁含冒号**。命名空间 / 领域前缀（如 codument modeling 的 shell kind `backend:endpoint`、`surface:route`）应放进 `kind` **属性块**表达，**不要写进标签名或 metadata**——标签名写冒号会触发 XNL 语法错（如 `Expected metadata key`）。

#### ❌ 错误示例

```xnl
<backend:endpoint #place_order { kind = "backend:endpoint" }> ❌ 错误！标签名 `backend:endpoint` 含冒号 → 语法错（解析器在冒号处期望 metadata key）
```

#### ✅ 正确示例

```xnl
<endpoint #place_order { kind = "backend:endpoint" }> ✅ 正确！标签名是普通词 `endpoint`，命名空间 kind 放进 `{}` 属性块
```


### component 四块未用裸标签
（codument modeling 约定）`component` 节点的 runtime / input / config / output 四块**用裸标签** `<runtime>` / `<input>` / `<config>` / `<output>`（canonical / 推荐）。`<types { role = "runtime" }>` 这类 role 写法 `validate` 也兼容接受，但**裸标签为推荐形式**。

#### ❌ 不推荐（accepted-but-discouraged）

```xnl
<component #place_order_proc { kind = "component" } [
  <types { role = "runtime" } ?r>type Runtime = { clock: Clock }</?r>
]>
```

#### ✅ 推荐（canonical）

```xnl
<component #place_order_proc { kind = "component" } [
  <runtime ?r>type Runtime = { clock: Clock }</?r>
  <input ?i>interface Input { cartId: string }</?i>
  <config ?c>interface Config { maxLines: number }</?c>
  <output ?o>interface Output { orderId: string }</?o>
]>
```
