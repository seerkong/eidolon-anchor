# 变更：将 Agent 资源创作迁移到 Effective VFS mutation transaction

## 背景和动机

当前 AgentDefinition authoring 先直接写 workspace ResourcePackage 文件，再让 registry 从物理 layers 刷新。G5-T1 后 runtime registry 已只接受 Effective VFS，因此创作必须把 durable workspace intent、candidate VFS、Halfcode readback、registry receipt 与 task freeze 串成一条可恢复 transaction。

## 目标

- Halfcode 继续拥有 proposal/plan/receipt 协议。
- workspace 文件只保存 durable overlay intent，不直接成为 runtime authority。
- 在 publication fence 内构造完整 candidate VFS、执行 Halfcode/authoring readback，最后一次 CAS publish。
- 任一失败不改变 current Effective VFS/registry，不生成 executable proof；重启可从 journal 幂等恢复。

## 非目标

- 不扩展为所有 Kind 的通用编辑器；先迁移 `AIAgentDefinition create`。
- 不反写 Builtin，不修改已冻结 parent closure。

## 影响

- `EidolonAIAgentDefinitionAuthoringAdapter`
- Effective VFS materializer candidate/admission surface
- autonomous Agent host 与 AI Data preparation tests
