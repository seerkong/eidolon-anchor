# 变更：通过 Eidolon Runtime 执行可修改 AIDataWorkflow RunGraph

## 背景和动机

Eidolon 已能加载 canonical AIDataWorkflow，但运行入口尚未执行 EagerDataFlow-backed RunGraph。产品要求每个 run 拥有可修改 DAG，节点具有输入、输出、配置、状态和 generation；修改后传递性失效，并在同一 run 内按语义指纹复用未变化结果。

## 目标

- 从 canonical AIDataWorkflow binding 创建并持久化 depa-flows RunGraph。
- 以 EagerDataFlow node/code contract 推进 ready nodes，保存节点输入、输出、配置、状态和结果证据。
- 支持 manual node 等待/恢复、GraphPatch、新 generation、传递性 invalidation。
- 保真 node-type 默认复用策略、节点显式覆盖、策略来源、run-local semantic reuse 和 `never`。
- 通过同一 Eidolon effect provider 承载 actor/tool/material effects，并复用 runtime-control lifecycle evidence。
- 扩展普通 workflow tools，使 run/status/events/result/resume/patch 能操作数据型 workflow facts。

## 非目标

- 不在 Eidolon 内重新定义 EagerDataFlow grammar、loader 或 RunGraph patch/reuse 语义。
- 不做跨 run 缓存。
- 不在本 track 实现 run graph promote 回 authoring definition。
- 不创建 workflow 专属 actor/session/provider/tool truth。

## 影响范围

- 行为：`eidolon-ai-workflow-native-capability`。
- 代码：`cell/packages/ai-organ-logic/src/workflow/runtime`、`tools`、workflow tests。
