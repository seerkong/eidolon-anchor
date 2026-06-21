## 上下文

前置的 vendor / symbiont / processor foundation 已经完成第一轮沉淀，当前最主要的残留问题不再是底层机制缺失，而是默认产品定义仍聚集在 runtime 入口。

当前代码中的典型症状：

- `cell/packages/composer/src/index.ts` 为空
- `cell/packages/mod-sys-kernel/src/index.ts` 为空
- `cell/packages/mod-sys-coding/src/index.ts` 为空
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts` 的 `createRuntimeBridge()` 仍直接持有：
  - `withDefaultAgents(...)`
  - 默认 system prompt
  - `buildAllTools(...)`
  - `composeToolRegistry()`
  - 默认 runtime bootstrap 接线

这意味着：

1. `terminal` 还在承担默认产品定义中心职责
2. `composer` 尚未成为正式组合层
3. `mod-sys-kernel` 与 `mod-sys-coding` 尚未成为默认能力 bundle 的宿主
4. 即使 `compose-dispatch-manifest-protocol` 已存在，组合面仍主要靠 runtime 入口手写静态装配

## 方案概览

第一轮只做“默认产品定义中心迁移”，不做完整 extension 生态。

目标结构：

1. `@cell/composer`
  - 提供 runtime composition contract
  - 负责消费 profile / extension / capability bundle
  - 输出统一的 runtime assembly result
2. `@cell/mod-sys-kernel`
  - 承接默认系统 bundle
  - 暴露默认 system prompt、default agent seed、default tool/route bootstrap
3. `@cell/mod-sys-coding`
  - 承接默认 coding overlay
  - 在 kernel bundle 之上叠加 coding agent、prompt overlay、coding capability 选择
4. `terminal`
  - 继续承接 shell I/O、projection bridge、session lifecycle、turn driver
  - 不再直接定义默认产品语义

## 组合对象模型

### Composer 层

`@cell/composer` 第一轮至少应暴露三类概念：

- `RuntimeProfile`
  - 描述 runtime 需要启用哪些 extension / overlay
- `RuntimeExtension`
  - 描述单个 extension 提供的 capability bundle、prompt fragment、agent seed、bootstrap hook
- `RuntimeAssemblyResult`
  - 描述最终装配结果，供 runtime 入口消费

同时，extension-facing 的正式 contract 也应归属于 composer，而不是由某个默认 bundle 反向定义：

- `RuntimeAssemblyContext`
- `RuntimeAssemblyState`
- `RuntimeBootstrapOptions`
- `RuntimeRegistries`
- `RuntimeToolingDescriptor`
- `RuntimeBootstrapDescriptor`
- `RuntimeSlashCommandDescriptor`

在本轮偏差修正后，`RuntimeAssemblyResult` 至少还应显式承接：

- default tooling composition result
- tool registry / runtime registries bootstrap
- slash route/action surface
- slash grammar / help / prompt-expansion descriptor
- capability / policy metadata

第一轮不要求做完整插件系统，但必须让上层调用方看到清晰边界：

- composer 负责组合
- mod package 负责声明默认产品语义
- runtime 入口只负责消费结果与接线
- extension/overlay 若要参与组合，只应依赖 composer 暴露的 contract，而不应反向依赖 kernel 取得类型真相源

同时还需要收紧一个工程结构不变量：

- `@cell/composer` 可以拥有 contract 与通用 assembly helper
- 默认 `kernel -> coding` profile 的聚合入口可以位于 composer 之上的薄层
- 但 composer 根包本身不应为了暴露默认 profile 而反向依赖 `@cell/mod-sys-kernel` / `@cell/mod-sys-coding`
- 否则虽然 contract ownership 已回到 composer，包依赖图仍会留下 `composer <-> mod` 的闭环，破坏“composer 为组合层、mod 为贡献层”的单向边界

### Kernel 与 Coding 分层

`@cell/mod-sys-kernel` 与 `@cell/mod-sys-coding` 是正交的两层：

- `mod-sys-kernel`
  - 默认系统能力
  - 任何默认 runtime 都应可复用
- `mod-sys-coding`
  - coding app 语义
  - 只在需要 coding profile 时叠加

因此第一轮推荐采用：

- 先由 kernel 定义基础 bundle
- 再由 coding overlay 叠加差异
- 最后由 composer 返回统一 assembly result

本轮修正需要把这个 layering 语义落实为显式不变量：

- `defaultCodingRuntimeProfile` 的扩展顺序必须是 `kernel -> coding`
- kernel 负责 baseline tooling / bootstrap / slash surface
- coding 只在 baseline 之上叠加 coding agent、prompt、delegate-agent capability selection 与 policy 差异

### Terminal 边界

`TerminalRuntime` 应继续保留：

- shell I/O bridge
- semantic projection bridge
- session runtime lifecycle
- orchestration / snapshot / recovery 接线

`TerminalRuntime` 不应继续保留：

- 默认 code agent 的定义
- 默认 system prompt 的正式真相源
- 默认工具集合的正式真相源
- 默认 slash/capability surface 的正式真相源

同时，`terminal/core` 里的 slash parser / help builder 也不应继续把 namespace/action grammar 固定写死为独立真相源；它只能保留通用解析框架，具体支持哪些 action、help 如何展示、prompt expansion 如何生成，应由 assembly contract 驱动。

## 影响范围与修改点

### Composer

- `cell/packages/composer/src/index.ts`
- 可能新增：
  - `cell/packages/composer/src/profile.ts`
  - `cell/packages/composer/src/assembly.ts`
  - `cell/packages/composer/src/extension.ts`

### Kernel

- `cell/packages/mod-sys-kernel/src/index.ts`
- 可能新增：
  - `cell/packages/mod-sys-kernel/src/systemPrompt.ts`
  - `cell/packages/mod-sys-kernel/src/defaultAgents.ts`
  - `cell/packages/mod-sys-kernel/src/tooling.ts`
  - `cell/packages/mod-sys-kernel/src/profile.ts`

本轮修正后，kernel 至少需要正式拥有：

- baseline prompt contribution
- baseline tooling descriptor / tool registry bootstrap
- baseline slash surface
- runtime registries bootstrap

但这些都应作为 baseline contribution 存在，而不是反向拥有 composer 的 extension contract 真相源。

### Coding

- `cell/packages/mod-sys-coding/src/index.ts`
- 可能新增：
  - `cell/packages/mod-sys-coding/src/overlay.ts`
  - `cell/packages/mod-sys-coding/src/profile.ts`
  - `cell/packages/mod-sys-coding/src/agents.ts`

本轮修正后，coding 至少需要正式拥有：

- default coding agent fallback
- coding prompt overlay
- delegate-agent capability selection metadata
- coding policy metadata

同时，coding overlay 应直接消费 composer 暴露的 contract 类型，不再通过 `@cell/mod-sys-kernel` 获取组装 contract。

### Terminal Adoption

- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- `terminal/packages/core/src/AIAgent/SlashCommands.ts`

第一轮目标是把下面这些 runtime-local 默认定义迁出：

- `withDefaultAgents(...)`
- 默认 system prompt 常量拼装
- 默认工具 registry 与 toolset 装配入口

本轮修正后，`TerminalRuntime` 还应进一步避免直接承担：

- 默认 runtime registries bootstrap 真相源
- 默认 slash route/action surface 真相源
- baseline tooling ownership 判断逻辑

`terminal/core` 则应退化为 descriptor-driven 的通用 slash 解析层：

- 保留 direct slash 的通用语法框架
- 根据 assembly descriptor 解析 action / args
- 根据 assembly descriptor 生成 `/<namespace> help`
- 根据 assembly descriptor 生成 prompt expansion
- 对非 runtime 调用方显式要求传入 descriptor，而不是提供模块级默认 fallback

而不是继续以静态 switch / 静态 help 文案维持一份平行 grammar truth。

这条约束也适用于 `terminal/packages/tui` 一类上层调用方：

- `TuiSdkFacade`、prompt 组件等若需要识别 formal slash，必须从 runtime/composer 侧显式取得 slash descriptor
- 如果某个同步 UI 路径当前拿不到 descriptor，应退化为“把 slash 输入交给 command/runtime 路径处理”，而不是回退到 `terminal/core` 私有默认表

## 决策

- 决策：第一轮只迁移默认产品定义中心，不重做 shell bridge
  - 理由：当前最高收益是把默认装配真相源迁出 `TerminalRuntime`，而不是扩大到 UI / session driver 重构

- 决策：composer 第一轮输出统一 `RuntimeAssemblyResult`
  - 理由：只有先把 runtime 入口的消费 contract 稳定下来，后续 extension/profile 才不会继续回流到入口层

- 决策：`mod-sys-kernel` 与 `mod-sys-coding` 分为基础 bundle 与 overlay
  - 理由：coding 语义不是所有 runtime 的默认基础，应通过 overlay 叠加，而不是继续与系统 bundle 混为一体

- 决策：第一轮允许 composer/mod 继续消费现有 `organ-logic` 低层构件
  - 理由：本 track 的重点是组合面归位，不是重新实现 tool registry 或 actor runtime 底层

- 决策：必须通过真实 `TerminalRuntime` adoption 验证，而不是只做空包示例
  - 理由：如果不接到真实入口，`composer/mod-sys-*` 仍会停留在占位包状态

## 风险 / 权衡

- 风险：composer 设计得过大，第一轮范围外溢到通用插件框架
  - 缓解：第一轮只支持默认 kernel + coding profile 的最小组合闭环

- 风险：mod package 只是把 `TerminalRuntime` 常量平移一份，未形成清晰 contract
  - 缓解：先定义 composer assembly result，再让 mod 包产出可组合的 bundle，而不是只导出散乱 helper

- 风险：tool registry / route surface 仍暗中保留第二套 runtime-local 真相源
  - 缓解：focused tests 要直接检查 `TerminalRuntime` 的默认来源已迁出，而不是只验证 mod 包单测

- 风险：slash namespace 虽已迁出，但 action dispatch 仍留在 terminal switch 中
  - 缓解：让 assembly 暴露 route/action manifest，并以 focused tests 验证 terminal 行为随其变化

- 风险：action-to-tool mapping 已迁出，但 parser/help/prompt expansion 仍保留在 `terminal/core` 静态表中
  - 缓解：将 slash grammar/help surface 一并并入 assembly descriptor，并补 focused tests 验证新增/移除 action 会同步影响 direct parse、help 与 prompt expansion

- 风险：overlay 顺序漂移后系统仍可运行，但 layering 语义已与 design 不一致
  - 缓解：将 `kernel -> coding` 顺序写入 contract，并用 focused tests 锁定

- 风险：把 terminal 里真正属于 shell bridge 的职责也一起迁走
  - 缓解：design 明确保留 terminal 的 bridge / projection / lifecycle 角色，不把这部分纳入本轮范围

## 兼容性设计

- 第一轮以内部重构为主
- 对外 terminal 使用方式尽量保持不变
- 若需要过渡 helper，只允许它们成为 composer/mod 的薄包装，不允许继续成为长期正式来源

## 迁移计划

1. 冻结 track 范围，补齐 design / plan / metadata / analysis
2. 在 `@cell/composer` 中建立最小组合 contract
3. 在 `@cell/mod-sys-kernel` 中落地默认系统 bundle
4. 在 `@cell/mod-sys-coding` 中落地默认 coding overlay
5. 让 `TerminalRuntime.createRuntimeBridge()` 切到 composer 装配结果
6. 运行 focused tests 与 `codument validate ... --strict`

## 待解决问题

- 第一轮的 profile surface 是否只支持内置 profile，还是允许提前暴露一个最小可扩展入口
- kernel bundle 是否直接产出 `ToolFuncRegistry`，还是产出更抽象的 tooling descriptor 再由 composer 统一收口
- coding overlay 的 prompt 叠加是通过 message fragment、agent profile 还是更高层 capability bundle 表达
