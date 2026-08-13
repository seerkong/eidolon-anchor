# Coding protocol

1. 判断结构化 invocation 是否已有 authoring session/workflow identity。没有 identity 的 confirmed create 直接用 `WorkflowCreateBundle(form,name,manifest_content,flow_code_content)` 原子建立完整双文件首 revision；所有 `src`/`type` 必须指向 `vfs://./flow-code/index.ts#<export>` 且 export 必须存在。有 identity 才读取该目标的 brief/tree 与 base/working revision。禁止为 fresh create 先做 broad catalog/list/summary discovery。
2. 依据 planning 结果选择 `EagerDataFlow` 或 `WorkCtrlFlow` substrate，再选择 `AIDataWorkflow` 或 `AICtrlWorkflow` profile。
3. 一次性确定 coherent candidate：列出明确 add/update/delete 文件，以当前 working revision 作为 `expected_revision`，通过一个 structured patch 原子提交。不要先创建半成品骨架再逐文件补全；不要在 prose 中复制源码。
4. mutation 后直接转 building/testing；只在 deterministic diagnostics 存在时读取必要 detail 并提交下一次 CAS 修复。canonical parse/validation diagnostic 可按精确错误码与行列纠正 candidate 后有界重试；provider transport、invalid tool-call payload 或 effect failure 立即终止并报告，不轮询、不猜测成功。
5. 使用 component 返回的 revision 与变更摘要，转交 building/testing；不要为了“确认”重复 summary/read。
6. 报告持久化边界：`session_opened` 表示草稿已保存到可恢复 authoring session；只有 `dry_run` 的纯 draft 才能表述为未持久化。authoring session 持久化不等于 publish，也不等于 run。

7. source budget：标准三源 flow-code ≤ 8,000 字符；不写说明性注释/重复类型/需求复述，复用小 helper。`WorkflowCreateBundle` 返回后不重读源码、不在 coding 重复 validate/complete，直接 transition 到 testing 的 compound proof command。

coding stage marker/receipt 一旦存在，本 stage 已激活；不要再次调用 `WorkflowLoadStageContext(stage=coding)`。完成 mutation 后才加载下一不同 stage。

允许工具：workflow catalog/create/read/edit/validate/diff。禁止 publish/deploy/run/monitor。
