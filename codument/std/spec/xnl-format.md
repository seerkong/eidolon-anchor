> **Provenance（vendored 注记）**
> - 来源：xnl-core `doc/ai-guide/XnlDataFormatForAi.md`
> - 版本：xnl-core 0.1.7
> - vendored 日期：2026-06-21
> - 原因：npm 包只发布 `dist/`，`doc/` 不在包内，故 vendor 一份作为 codument 的 XNL 语法权威。

# XNL 数据格式（大模型版）
XNL（Extensible Notation Language）
用于提示大语言模型理解与生成新版短标签的 XNL（Extensible Notation Language）。语法沿用 XML 风格起始标签，但闭合极简，便于对话/提示场景快速书写。

## 核心语法速览
- 开始标签：`<name metadata... sections...>`。
- 元数据：`key=value` 紧跟在标签名后，可有多个。
- 属性块：`{ key = value ... }` → 存入 `attributes`。
- 数组块：`[ item1 item2 <child> ]` → 存入 `body`（元素可为值或子节点）。
- 唯一子节点块（extend）：`( <child1> <child2> )` → 存入 `extend`，同名覆盖旧值并警告，保持出现顺序。
- 文本块：`<name metadata {attr} ?marker> ... </?marker>`，允许 metadata/`{}`，禁止 `[]`/`()`；标记可选但必须首尾一致。
- 无其它块时直接以 `>` 结束节点。

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
  <metadata_demo1 xx=1 {
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
  <text1 a=1 {b="zh"} ?>
    在纯文本内部，无需转义，例如 & < > #
    可以包含形如 <notatag 的内容，均按文本处理
    多行文本会按结束标签所在行的缩进去除前缀
  </?>
  <text2 a=1 {b="cc"} ?flag_1234>
    如果文本中包含 `</?>` 字样，可在开始标签后加标记，如 `?flag_1234`
    结束标签必须使用相同标记 `?flag_1234`
  </?flag_1234>
]>
```

## 生成检查清单
- 文本块用 `<name ... ?marker?> ... </?marker?>`，不与 `[]`/`()` 同用；metadata 与 `{}` 可放在 `?` 前。
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
XNL 元素标签名**禁含冒号**。命名空间 / 领域前缀（如 codument modeling 的 shell kind `backend:endpoint`、`surface:route`）应放进 `kind` **属性**表达，**不要写进标签名**——标签名写冒号会触发 XNL 语法错（如 `Expected metadata key`）。

#### ❌ 错误示例

```xnl
<backend:endpoint id="place_order" kind="backend:endpoint"> ❌ 错误！标签名 `backend:endpoint` 含冒号 → 语法错（解析器在冒号处期望 metadata key）
```

#### ✅ 正确示例

```xnl
<endpoint id="place_order" kind="backend:endpoint"> ✅ 正确！标签名是普通词 `endpoint`，命名空间 kind 放进 `kind` 属性
```


### component 四块未用裸标签
（codument modeling 约定）`component` 节点的 runtime / input / config / output 四块**用裸标签** `<runtime>` / `<input>` / `<config>` / `<output>`（canonical / 推荐）。`<types role="runtime">` 这类 role 写法 `validate` 也兼容接受，但**裸标签为推荐形式**。

#### ❌ 不推荐（accepted-but-discouraged）

```xnl
<component id="place_order_proc" kind="component" [
  <types role="runtime" ?r>type Runtime = { clock: Clock }</?r>
]>
```

#### ✅ 推荐（canonical）

```xnl
<component id="place_order_proc" kind="component" [
  <runtime ?r>type Runtime = { clock: Clock }</?r>
  <input ?i>interface Input { cartId: string }</?i>
  <config ?c>interface Config { maxLines: number }</?c>
  <output ?o>interface Output { orderId: string }</?o>
]>
```
