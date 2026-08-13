# Workflow workspace contract

workspace 是可编辑定义的事实 owner。编辑必须基于明确 revision，写入只产生新 revision。建议布局：

```text
workflow.xnl
resources.xnl
functions/
tests/
proofs/
```

文件引用必须可从 workspace root 解析；禁止写绝对机器路径、运行快照、provider secret 或 publication id。validate 成功不等于发布；publication 是 releasing stage 的独立动作。

## Mutation discipline

- 先读取 brief/tree 和必要 detail，锁定一个 `expected_revision`；一个 coherent 编辑目标只发出一次 structured `WorkflowWorkspace(operation=patch)`。
- `operations[]` 使用显式 `add | update | delete` 与完整文件 content。组件会在任何操作失败或 CAS 冲突时保持 workspace、metadata、proof 全部不变。
- 一次提交完整可解析的 manifest、resources、workflow 和 functions 闭包；源码只进入 tool arguments，不在 reasoning/prose 复述。
- 只有 deterministic diagnostics 要求修复时才读取对应 detail 并提交下一次 CAS patch；不得通过逐文件 write/read 循环“探索性落盘”。
- 工具返回 `ok=false` 或 provider effect 失败就是当前动作失败的唯一事实；停止后续 mutation，保留 authoring session 供下一轮恢复。
