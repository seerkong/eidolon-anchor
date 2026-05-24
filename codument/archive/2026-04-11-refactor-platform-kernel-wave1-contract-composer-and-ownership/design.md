# 设计：Wave 1 的 contract / composer / ownership 收口

## 1. 波次定位

本波次只处理三件事：

1. platform contract
2. platform composer contract
3. ownership tables

它是后续所有波次的前置条件，因为：

- profile layering 不能建立在 AI-shaped composer contract 上
- shell adoption 不能在 ownership 未冻结的前提下推进
- package cleanup 不能先于 contract truth source 收口

## 2. 目标结果

### 2.1 platform contract

Wave 1 的目标不是把所有平台 contract 一次做完，而是建立第一版正式宿主边界。它至少要能承载：

- actor / fiber / mailbox
- manifest / bundle / profile / bootstrap
- event log / projection / replay
- hook / permission / policy

它明确不承载：

- provider / model runtime
- tool calling
- questionnaire / approval
- AI semantic event taxonomy
- member / teammate / holon / agent identity
- AI slash contract

### 2.2 platform composer contract

`@cell/composer` 继续保留包名，但其 contract 要变成平台级 capability composition contract。

这意味着：

- `RuntimeAssemblyContext / State / Result` 目标上不直接依赖 `AgentConfig`
- 不直接依赖 `ToolSchema`
- 不直接依赖 `actor/member/holon` 这类 AI-shaped slash surface
- AI domain 通过自己的 assembly facet / descriptor / contribution 扩展 platform composer

### 2.3 ownership tables

本波次必须产出三张表：

- contract ownership table
- runtime facet table
- package mapping table

三张表的作用：

- 为后续 wave 提供唯一正式边界基线
- 避免 profile/shell/package cleanup 再次发散解释边界

## 3. 兼容策略

本波次遵循保守增量策略：

- 允许旧包名继续存在
- 允许 AI runtime 仍通过现有路径运行
- 允许物理迁移延后到 Wave 4

但以下边界必须立即冻结：

- platform contract 的目标 ownership
- composer contract 的目标 ownership
- `AiAgentVm` 相关 state 的 platform/domain facet ownership

## 4. 非目标

本波次不做：

- `platform-only` profile 实际接线
- shell/runtime entry cutover
- 大规模 rename
- AI support 全量迁移

## 5. 风险

### 风险 1：只做 facade，不做 ownership 收口

如果只是把类型拆成 facade，而不真正迁出 AI-shaped ownership，后续 profile 和 shell adoption 仍会继续依赖错误边界。

### 风险 2：新建平行 composer 包

如果再造一个新的 composer 包，会立即形成双真相源，违背微内核升级目标。

### 风险 3：focused tests 退化为 grep

如果验证只看 import 或文件路径，后续仍可能在行为上保留错误 ownership。

## 6. 成功标准

Wave 1 达到以下条件时视为完成：

- 第一版 platform contract 宿主边界明确
- `@cell/composer` contract 已收口为平台级 composition contract
- ownership tables 正式产出并可供后续 wave 直接引用
- 当前 AI runtime 主路径持续可运行
