# Design: workflow run/fact/material lifecycle on Eidolon

## 产品对象与 authority

`WorkflowDefinitionRevision` 是发布资源的内容寻址快照；`WorkflowInstance` 绑定一个精确 revision，并持有可在 start 前修改的 input facts 与 exact Material bindings；`WorkflowRunDescriptor` 在 confirmed start 时冻结 instance revision、input 和 bindings；`WorkflowRunReceipt` 追加运行的 exact input/output Material refs 与 provenance。

workflow fact store 是上述对象的单写者。depa-flows controller/driver 保存图、节点、generation 与 workflow execution facts；Eidolon actor/session/runtime-control 保存 agent/tool/human effect lifecycle。workflow descriptor 只引用它们，不复制其内部事实。

## 状态机

Instance 从 `Prepared` 进入 `Running` 后 input 与 bindings 不再可改；每个新执行或 replay 创建独立 Run。Start 分为 preview 与 commit：缺少 `confirmed=true` 时只返回将冻结的 definition、input、bindings 和风险，不分配可观察 Run、不触发 effect。

Run 使用稳定 caller-supplied `run_id` 和请求指纹。相同 id/相同请求返回既有结果；相同 id/不同请求拒绝。等待节点由既有 depa-flows/Eidolon effect lifecycle 产生 pending handle；resolve/reject 只能命中当前 pending handle。

## Definition freeze 与恢复

创建 Instance 时把标准 XNL bundle 文件和 loader 解析出的 form 写入 immutable revision store。运行 controller/driver 从该 snapshot 加载，而不是重新解析 `resource://` 的 current publication。fresh runtime 只需 fact root 与 Eidolon session context 即可重建 service、controller/driver 和 pending state。

## Material 生命周期

Material import 在 workspace containment 与 symlink 检查后计算内容 hash，生成 immutable revision、manifest 与 provenance；逻辑 ref 可以拥有多个 revision，但 binding 必须是 exact revision。Binding key 包含 instance、statement/node 与 port。Start 把 bindings 复制到 receipt 并建立 lease；output 通过受限 Material capability 写入后登记 exact revision。

Export 与 cleanup 都是有副作用的独立确认操作。Replay 以旧 receipt 的 exact refs 创建新 instance/run，不读取 current binding。Cleanup 仅删除无 instance/run lease 的 revision，且未确认只返回候选计划。

## Native component projections

运行生命周期服务位于 workflow component 内；tools 与 `eidolon workflow` CLI 只做 schema/人类呈现适配。旧 direct `WorkflowRun(workflow_ref)` 不再是执行旁路：调用者必须先 create instance，再以 instance/run id 和 confirmation start。

## 明确架构边界

- authoring/definition 格式为 XNL，解析和执行继续委托 depa-flows。
- roots 由 Eidolon profile/runtime 注入，默认工程布局使用 `.eidolon` ownership。
- 公开 operations 通过 native component tools 与 CLI commands 提供。
- effects 使用 Eidolon actor/session/runtime-control adapters；产品 facts 与确认语义保持不变。
