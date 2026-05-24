# 变更：将 cell runtime 收口到 composer 与 mod profiles

## 背景和动机 (Context And Why)

前置的三个基础能力已经具备第一轮可用形态：

- `vendor-data-graph-stream-foundations`
- `vendor-actor-runtime-foundations`
- `compose-dispatch-manifest-protocol`

当前剩余的主要问题，已经不再是 vendor foundation 缺失，而是默认产品定义仍然散落在运行时入口：

- `@cell/composer` 仍为空，尚未成为正式组合层
- `@cell/mod-sys-kernel` 仍为空，默认系统 bundle 没有独立宿主
- `@cell/mod-sys-coding` 仍为空，默认 coding overlay 没有独立宿主
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts` 的 `createRuntimeBridge()` 仍直接内嵌：
  - `withDefaultAgents(...)`
  - 默认 system prompt
  - `buildAllTools(...)`
  - `composeToolRegistry()`
  - 默认 runtime bootstrap 语义

这会导致三个直接问题：

- `terminal` 仍然既是 shell bridge，又是默认产品定义中心
- profile / extension / capability bundle 还没有正式组合面，无法稳定承接后续微内核化
- 即使前置 vendor/processor foundation 已存在，上层仍主要靠手写静态装配接线

本 track 的目标，是在不重写 shell bridge 的前提下，把默认产品语义从 `core/organ/terminal` 中外移到 `composer + mod-sys-*`，形成一个可以继续扩展 profile / extension 的正式组合层。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**

- 定义 `@cell/composer` 的最小正式组合职责，使其能消费 profile / extension / manifest bundle 并生成 runtime 装配结果
- 让 `@cell/mod-sys-kernel` 承接默认系统能力 bundle，包括默认 system prompt、默认 agent seed、默认工具/命令装配入口
- 让 `@cell/mod-sys-coding` 承接默认 coding overlay，包括 coding agent、coding prompt overlay、coding capability 选择与相关策略
- 将 `TerminalRuntime` 的默认产品语义切换为依赖 composer 返回的装配结果，而不是继续硬编码在 runtime 入口里
- 用 focused tests 锁定组合层、默认 mod profile 与 terminal cutover 的行为边界

**非目标:**

- 不在本 track 中继续设计新的 vendor foundation
- 不在本 track 中重做 `vendor/depa-processor` 的 manifest 协议
- 不把 shell I/O、projection bridge、turn 驱动从 terminal 中移除
- 不要求第一轮就完成通用第三方 extension 生态
- 不要求第一轮就把所有工具目录都改为 profile-aware，只要求把默认产品定义中心迁出 `TerminalRuntime`

## 变更内容（What Changes）

- 在 `@cell/composer` 中建立正式的 runtime composition surface：
  - profile / extension descriptor
  - capability bundle 装配
  - runtime assembly result contract
- 在 `@cell/mod-sys-kernel` 中建立默认系统 bundle：
  - 默认 system prompt
  - 默认 agent seed
  - 默认 tool/route/command 装配入口
  - 默认 runtime bootstrap 规则
- 在 `@cell/mod-sys-coding` 中建立默认 coding overlay：
  - coding agent / coding prompt overlay
  - coding capability bundle
  - coding 策略入口
- 在 `terminal` 中完成第一轮 cutover：
  - `createRuntimeBridge()` 不再直接作为默认产品定义中心
  - runtime 改为消费 composer 产出的默认 profile 装配结果
- 在 `core/organ` 中只保留被 composer/mod 消费的低层构件，不再继续承载默认应用拼装逻辑

## 第一轮实施范围

本 track 第一轮需要收敛到一个可直接实现、可验证的最小闭环：

1. 在 `@cell/composer` 中补齐最小的组合 contract 与装配 helper；
2. 在 `@cell/mod-sys-kernel` 中落地默认系统 bundle；
3. 在 `@cell/mod-sys-coding` 中落地默认 coding overlay；
4. 让 `TerminalRuntime.createRuntimeBridge()` 切到 composer/profile 装配结果；
5. 用 focused tests 验证：
   - composer 能消费 mod profile 并生成稳定装配结果；
   - terminal 的默认 agent / prompt / tool registry 来源已迁出 runtime 入口；
   - shell bridge 行为不回归。

## 直接执行的交付物

第一轮交付物至少包括：

- `cell/packages/composer/src/*` 中的 runtime composition contract 与 helper
- `cell/packages/mod-sys-kernel/src/*` 中的默认系统 bundle
- `cell/packages/mod-sys-coding/src/*` 中的默认 coding overlay
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts` 的第一轮 cutover
- focused tests：
  - composer/mod profile 组合
  - terminal 默认 runtime 装配来源
  - 既有 terminal runtime 回归路径
- 自包含设计文档，说明 composer、mod-sys-kernel、mod-sys-coding 与 terminal 的边界

## 本 track 不做什么

- 不继续修改 `vendor/depa-data-graph`、`vendor/depa-actor`、`vendor/depa-processor` 的底层协议
- 不把 `terminal` 的 shell I/O、projection bridge、turn driver 抽出到别处
- 不要求第一轮就把所有内部 runtime 都切到 composer/profile
- 不要求第一轮就支持动态安装第三方 mod marketplace

## 影响范围（Impact）

- `cell/packages/composer`
- `cell/packages/mod-sys-kernel`
- `cell/packages/mod-sys-coding`
- `cell/packages/core-logic`
- `cell/packages/organ-logic`
- `terminal/packages/organ`
- 相关 composer/profile 文档与 focused tests

## 成功标准

- 默认系统能力与默认 coding 能力不再写死在 `TerminalRuntime`
- `@cell/composer` 成为默认 runtime 装配的正式组合层
- `@cell/mod-sys-kernel` 与 `@cell/mod-sys-coding` 成为默认产品语义的正式宿主
- `terminal` 保持 shell bridge 身份，不再承担默认产品定义中心职责
- track 的 `design.md` 与 `plan.xml` 足以直接指导实现执行
