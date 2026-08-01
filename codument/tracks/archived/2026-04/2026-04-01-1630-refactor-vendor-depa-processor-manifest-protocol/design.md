## 上下文

当前项目已经把 `runByFuncStyleAdapter` 作为标准化组件执行协议广泛使用，但这套协议仍主要停留在“如何运行一个组件”的层面，还没有成为“如何声明、导出、变体化、组合、路由组件”的正式协议。

当前痛点主要有四类：

1. 组件定义分散在目录级 `index.ts` 中，但 `index.ts` 只是重复样板，没有成为正式 manifest 编排层
2. 上层注册主要依赖 `ToolFuncBuiltin.ts` 里的静态 import + 静态数组
3. slash / route / command 的组合还主要依赖手写 switch，而不是正式 bundle/manifest 协议
4. 虽然已经有组件执行协议，但缺少一种方式，让“同一目录下的多个导出变体”成为一等公民

用户对本 track 的补充约束非常明确：

- `vendor/depa-processor/src/actor/*` 可忽略，它不是本轮演化目标
- 需要保留每个组件目录中的 `index.ts`，并让它成为正式的 export/manifest 编排层
- 同一目录必须能够根据配置导出多个组件变体
- 真实使用场景以 `tasktree` 为例，需要能够表达“单层 task”与“树形 task”两类变体，且不同变体可以绑定不同 prompt/schema/config

因此，本 track 的设计目标不是“生成式地消灭 `index.ts`”，而是：

- 让 `index.ts` 从手工 glue code 升级为正式 manifest authoring layer
- 让 `depa-processor` 从执行协议库升级为组件 manifest 与分发协议库

## 方案概览

本 track 第一轮只做一个最小但完整的闭环：

1. 在 `vendor/depa-processor` 中补齐 manifest 协议
2. 在 vendor 中补齐 manifest -> registry / route 的最小组合能力
3. 选择 `TaskTreeRead` / `TaskTreeWrite` 作为真实 adoption 目录
4. 在该目录内导出 tree / flat 两个 variant
5. 保持当前 `TaskTreeRead` / `TaskTreeWrite` 默认兼容 surface 仍可用，但其实现改为从 manifest 默认 variant 派生

### 第一轮的边界

第一轮只证明下面三件事：

1. 目录级 `index.ts` 可以导出多个 manifest variant
2. variant 可以切换 prompt/schema/config
3. 上层可以通过 manifest composition 装配 registry，而不再要求组件只能通过全局静态列表注册

第一轮**不**要求：

- 全部现有工具迁移到 manifest protocol
- `ToolFuncBuiltin.ts` 被彻底删除
- `@cell/composer` 已经接入这套协议
- route/command surface 完成全量切换

## 目标结构

### 1. vendor 层：组件 manifest 协议

第一轮在 `vendor/depa-processor` 中新增一组正式概念：

- `ComponentManifest`
- `ComponentVariantManifest`
- `ComponentBundleManifest`
- `ManifestRegistryComposer`

建议放置方式：

- `src/component/manifest-types.ts`
- `src/component/manifest-builders.ts`
- `src/component/manifest-compose.ts`

并在：

- `src/component/index.ts`
- `src/index.ts`

中正式导出。

### 2. 目录级 `index.ts` 的新职责

目录级 `index.ts` 在第一轮中承担三类职责：

1. 选择本目录导出哪些组件
2. 决定默认导出哪个 variant
3. 为每个 variant 绑定：
   - schema
   - prompt
   - config
   - route/export metadata

第一轮不要求 `index.ts` 直接承载核心逻辑；核心逻辑仍留在：

- `Logic.ts`
- `OuterTypes.ts`
- `InnerTypes.ts`

`index.ts` 只做 manifest authoring。

### 3. 上层组合方式

第一轮只要求最小组合能力：

- `ManifestRegistryComposer.composeToolDefs(...)`
  - 输入：多个 manifest / variant manifest / bundle manifest
  - 输出：可直接注册到现有 `ToolFuncRegistry` 的 defs

可选再提供：

- `ManifestRegistryComposer.composeRouteKeyMap(...)`
  - 为后续 command/route bundle 铺路

第一轮不要求改写现有所有 router；只要求 vendor 拥有最小组合能力，并能在项目侧被真实调用。

## Manifest 模型设计

### 1. `ComponentManifest`

第一轮建议 `ComponentManifest` 保持足够小，只承载“正式导出所需的最小信息”：

```ts
type ComponentManifest<TDef = unknown> = {
  id: string
  kind: "tool" | "command" | "route" | "component"
  exportName: string
  variantKey?: string
  tags?: string[]
  build: () => TDef
  meta?: Record<string, unknown>
}
```

其中：

- `id`：全局稳定标识
- `kind`：组件类别
- `exportName`：对外导出名
- `variantKey`：当前 manifest 的变体标识
- `build`：延迟构造正式 def，避免 import 时立即实例化

### 2. `ComponentVariantManifest`

用于把“一个逻辑组件的多种导出变体”组织到一起：

```ts
type ComponentVariantManifest<TDef = unknown> = {
  baseId: string
  defaultVariant: string
  variants: Record<string, ComponentManifest<TDef>>
}
```

这允许目录级 `index.ts` 显式表达：

- 哪个 variant 是默认导出
- 哪些 variant 仅供特定 bundle 使用

### 3. `ComponentBundleManifest`

用于把多个目录的 manifest 聚合为 bundle：

```ts
type ComponentBundleManifest<TDef = unknown> = {
  id: string
  manifests: Array<ComponentManifest<TDef> | ComponentVariantManifest<TDef>>
}
```

第一轮 bundle 只要求静态组合，不要求依赖解析或 profile overlay。

## Authoring Helper 设计

第一轮建议提供三类 helper：

### 1. manifest builder

```ts
createComponentManifest(...)
```

用途：

- 让目录级 `index.ts` 以统一格式导出单 manifest

### 2. variant builder

```ts
createComponentVariantManifest(...)
```

用途：

- 统一表达 default variant 与 variants map

### 3. bundle builder

```ts
createComponentBundleManifest(...)
```

用途：

- 为后续 `@cell/composer` 的 extension/profile 装配做准备

这些 helper 的目标不是隐藏结构，而是：

- 统一格式
- 明确默认值
- 减少目录级 `index.ts` 的重复样板

## `TaskTreeRead` / `TaskTreeWrite` 的第一轮 adoption

### 总体策略

第一轮真实 adoption 选择：

- `cell/packages/organ-logic/src/composer/AIAgent/tools/TaskTreeRead`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/TaskTreeWrite`

理由：

- 它们天然属于同一个业务簇
- 用户已经明确提出“单层 task / 树形 task”的目标场景
- 当前两个工具都还是单一导出，正适合验证多 variant manifest

### 默认兼容策略

第一轮默认采用：

- `tree` variant 作为默认兼容导出
- 现有 `TaskTreeRead` / `TaskTreeWrite` 名称保持不变
- 当前调用方如果不感知 manifest，新行为仍使用 tree variant

这样可以保证：

- 第一轮主要验证 manifest protocol
- 而不是同时引入大面积 runtime 行为破坏

### `TaskTreeWrite` 变体设计

第一轮建议导出两个 variant：

1. `tree`
   - 保持当前能力
   - 支持：
     - `replace_root`
     - `expand`
     - `update_status`
   - prompt 与 schema 保持“层级任务树”语义

2. `flat`
   - 收紧为单层任务模式
   - 第一轮建议：
     - 禁止 `expand`
     - `tasks` 仅表达根层任务集合
   - prompt 改为“单层任务列表管理”
   - schema 的 `op.enum` 去掉 `expand`
   - config 注入 `{ mode: "flat" }`

核心逻辑策略：

- 复用 `taskTreeWriteCoreLogic`
- 在 inner config 中传入 mode
- 由 core logic 或其前置适配层在 `flat` 模式下拒绝 `expand`

### `TaskTreeRead` 变体设计

第一轮建议导出两个 variant：

1. `tree`
   - 保持当前行为
   - 输出完整 task tree JSON

2. `flat`
   - 输出 flatten 后的任务数组或单层任务视图
   - prompt 改为“单层任务读取”
   - config 注入 `{ mode: "flat" }`

核心逻辑策略：

- 复用现有 read core
- 在 output adapter 或 core logic 中根据 `mode` 决定输出 tree 还是 flat 视图

### 目录级 `index.ts` 的目标形态

第一轮后，`TaskTreeWrite/index.ts` 与 `TaskTreeRead/index.ts` 应不再只是：

- 一个 `buildXXXToolDef()`

而应具备下面结构：

```ts
export const taskTreeWriteVariants = createComponentVariantManifest(...)

export function buildTaskTreeWriteToolDef() {
  return buildToolDefFromManifest(taskTreeWriteVariants.variants.tree)
}
```

也就是：

- 同时导出 variant manifest
- 同时保留默认兼容 wrapper

## 项目侧最小接入方案

### 第一轮不全量替换 `ToolFuncBuiltin.ts`

为了控制改动面，第一轮只做“局部 manifest 接入”：

- `TaskTreeRead`
- `TaskTreeWrite`

其余工具继续维持现有静态列表方式。

### 建议接线方式

在 `ToolFuncBuiltin.ts` 中：

- 对大多数工具仍直接调用 `buildXXXToolDef()`
- 对 `TaskTreeRead` / `TaskTreeWrite`：
  - 默认 wrapper 改为从 manifest 默认 variant 派生

在测试中增加：

- manifest compose 测试
- tasktree variant export 测试

这样第一轮既能证明协议可用，又不把全局注册面一次性打散。

## 影响范围与修改点

### vendor

- `vendor/depa-processor/src/component/*`
- `vendor/depa-processor/src/router/*` 或相邻新增组合文件
- `vendor/depa-processor/src/index.ts`
- `vendor/depa-processor/tests/*`

### 项目侧真实 adoption

- `cell/packages/organ-logic/src/composer/AIAgent/tools/TaskTreeRead/index.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/TaskTreeRead/Logic.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/TaskTreeWrite/index.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/TaskTreeWrite/Logic.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/ToolFuncBuiltin.ts`
- 相关测试

## 决策

- 决策：保留目录级 `index.ts` 作为 manifest authoring layer
  - 理由：这正是用户需要的显式导出控制能力来源

- 决策：第一轮只做一个真实 adoption 目录簇
  - 理由：要验证协议，但不能让第一轮演变成全量工具迁移

- 决策：`TaskTreeRead` / `TaskTreeWrite` 默认兼容导出仍采用 `tree` variant
  - 理由：先验证 manifest/variant 协议，再决定是否要在更后续 track 中调整默认 surface

- 决策：第一轮仍保留 `ToolFuncBuiltin.ts`
  - 理由：第一轮目标是“manifest protocol 可用”，不是“全局注册体系一次性替换”

- 决策：第一轮 route/command composition 只做最小实现
  - 理由：要先证明 manifest 可以装配成 registry/route，而不是一次性重写 terminal command surface

## 风险 / 权衡

- 风险：manifest 设计过重，第一轮就滑向 profile/extension 框架
  - 缓解：第一轮只保留 component/variant/bundle/compose 四个概念，不引入 profile 解析

- 风险：`TaskTreeRead` / `TaskTreeWrite` 变体行为差异不足，导致 adoption 沦为形式化改名
  - 缓解：要求 `flat` variant 至少在 prompt/schema/config 三处同时变化

- 风险：第一轮引入 manifest 与 legacy builder 双轨，增加短期复杂度
  - 缓解：只允许 tasktree 目录进入双轨；其余目录维持 legacy，不扩大双轨面

- 风险：route composition 过早绑定到某一种 command surface
  - 缓解：第一轮只提供最小 compose helper，不把 terminal 现有 slash 命令整体替换

## 兼容性设计

- 第一轮按“最小兼容迁移”执行
- 保留现有 `buildTaskTreeReadToolDef()` / `buildTaskTreeWriteToolDef()` surface
- 默认兼容 surface 继续导出 tree variant
- 不要求其他工具同步迁移

## 迁移计划

1. 在 vendor 中定义 manifest/variant/bundle/compose 协议
2. 补 authoring helper 与最小 compose helper
3. 为 tasktree 目录实现 tree/flat variant manifest
4. 保留兼容 wrapper，并让默认 wrapper 从默认 variant 派生
5. 增加 vendor 测试与项目侧真实 adoption 测试
6. 最后再评估第二轮是否扩大到更多工具目录

## 待解决问题

- `flat` variant 的 `TaskTreeRead` 输出格式是“平铺 tasks 数组”还是“平铺 + parent_id 元数据”
- 第一轮最小 route compose helper 是放在 `component/` 还是 `router/` 更清晰
- 第二轮是否要为 `ToolFuncBuiltin.ts` 引入 manifest bundle 接口，替换部分静态 import
