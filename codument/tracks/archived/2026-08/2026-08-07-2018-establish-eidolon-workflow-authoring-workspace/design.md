# 设计：共享 Workflow Authoring Workspace

## Authority 边界

- depa-flows loader 是 profile parse/link/diagnostic authority。
- `WorkflowAuthoringStore` 是资源读写 effect contract；Node filesystem implementation 只负责受控本地 IO。
- `WorkflowAuthoringWorkspace` 拥有 draft/validate/publish/edit/delete/diff 等 transition，不拥有 workflow semantic core。
- CLI 与 model-visible tools 都调用 runtime-bound `WorkflowComponent`，不得自行写 workflow 文件。

## Binding

`createWorkflowComponent(options)` 接受显式 workspace root/store；`createWorkflowComponentForRuntime(runtime)` 从 `outerCtx.metadata.aiWorkflow.roots.workspaceRoot` 取得根，缺失时以 `workDir/.eidolon/workflows` 为保守默认。两者构造同一 workspace/service graph。

## 路径与发布

Bundle draft 文件路径相对 workflow workspace root，例如 `<slug>/manifest.xnl`。Store 在每次操作前解析并检查 containment，拒绝绝对路径、空路径和 traversal。Publish 先 canonical validate draft source set，再把每个文件写入同目录临时文件并 rename；完成后重新读取 manifest 并 canonical validate，返回 revision/content hashes 和写入证据。

## Surface projection

- `WorkflowCreateBundle` 默认发布；`dry_run=true` 时只返回经过 canonical proof 的 draft。
- CLI `workflow init` 创建带 workspace binding 的 component，并调用相同 command；terminal 不再拥有 workflow mkdir/write loop。
- patch tool 通过 workspace read/write/validate transition 处理 replacement manifest；无 replacement 时仍返回纯计划。

## 验证

- store containment 和 authoring operations 单测；
- tool runtime 与 CLI 指向临时 workspace，验证生成内容和 publish evidence 等价；
- 源码扫描确保 CLI 无 workflow 私有 `mkdir`/`writeFile`，tool 不再无参创建 component。
