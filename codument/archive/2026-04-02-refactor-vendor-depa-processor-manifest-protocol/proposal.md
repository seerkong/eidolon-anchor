# 变更：沉淀 vendor compose-dispatch manifest protocol

## 背景

当前项目已经大面积使用 `runByFuncStyleAdapter` 作为标准化组件执行协议，这是很好的基础。但组件的注册、导出、组合、路由仍主要停留在：

- 每个目录手写 `index.ts`
- 全局静态 import + 静态列表聚合
- 手写 registry 注册
- 手写 slash/command 路由

这意味着 `depa-processor` 目前更多只是执行协议，而还不是正式的组件 manifest 与分发协议。

本 track 的目标不是取消每个 tool 目录的 `index.ts`，恰恰相反，是要保留 `index.ts` 作为 manifest/export 编排层，让同一目录可以显式导出不同组件变体、不同 schema、不同 prompt、不同 capability manifest。

## 变更内容

- 在 `vendor/depa-processor` 中定义 component manifest、bundle manifest、variant/export manifest
- 提供 registry composer、route bundle、command bundle 等协议与工具
- 提供适用于目录级 `index.ts` 的 authoring helper，让目录内组件可以显式导出多种变体
- 使 `runByFuncStyleAdapter` 从“组件执行协议”扩展到“组件 manifest 与分发协议”的一部分

## 第一轮实施范围

本 track 第一轮应直接收敛到一个可开工、可验证的最小闭环：

1. 在 `vendor/depa-processor` 中补齐以下正式概念：
   - `ComponentManifest`
   - `ComponentVariantManifest`
   - `ComponentBundleManifest`
   - `ManifestRegistryComposer`
2. 提供目录级 `index.ts` authoring helper：
   - 支持导出单个默认 manifest
   - 支持导出多个 variant manifest
   - 支持按 bundle 聚合多个目录 manifest
3. 提供一个最小 command/route composition 接口，证明 manifest 可以被装配成路由或 registry
4. 在本仓库中选择一个真实目录做第一轮接入验证，推荐：
   - `tasktree` 相关工具目录
   - 或一个同样具备 prompt/schema 差异的工具目录
5. 用该真实目录验证：
   - 同目录导出两个 variant
   - variant 能切换 prompt/schema/config
   - 上层 registry 能按 manifest 装配，而不是继续只靠全局静态列表

## 第一轮不做什么

- 不要求第一轮就把 `cell/packages/organ-logic/src/composer/AIAgent/ToolFuncBuiltin.ts` 完全替换掉
- 不要求第一轮就让全部现有工具切到 manifest protocol
- 不要求第一轮就建立完整的 `@cell/composer` extension/profile 装配层
- 不处理 `vendor/depa-processor/src/actor/*` 早期残留代码
- 不把 AI-specific prompt 文本、Outer/InnerTypes 直接沉淀到 vendor

## 直接执行的交付物

第一轮交付物应至少包括：

- `vendor/depa-processor/src/component/*` 中的 manifest 类型与 helper
- `vendor/depa-processor/src/router/*` 或相邻目录中的 manifest-to-route composition helper
- vendor 侧测试：
  - 单 manifest
  - 多 variant manifest
  - bundle compose
  - route/registry compose
- 项目侧一个真实目录的变体验证
- 文档中明确：
  - 为什么保留目录级 `index.ts`
  - variant manifest 如何切换 prompt/schema/config
  - bundle 如何被上层消费

## 本 track 不做什么

- 不处理 `vendor/depa-actor` 中的 actor runtime foundation
- 不处理 `vendor/depa-data-graph` 中的 stream foundation
- 不消灭每个 tool 目录中的 `index.ts`
- 不把 AI-specific prompt 与 Outer/InnerTypes 直接沉淀到 vendor

## 影响范围

- `vendor/depa-processor`
- `cell/packages/organ-logic`
- 后续会影响 `@cell/composer`、`@cell/mod-sys-*` 的 capability 装配方式
- 相关工具测试与文档

## 成功标准

- `index.ts` 成为正式 manifest/export 编排层
- 同一目录可导出多个变体
- 全局静态列表聚合开始可以被更正式的 bundle/manifest 协议替代
- 第一轮存在至少一个真实目录级变体验证，不只是 vendor 内部空转抽象
