# Releasing protocol

消费 `WorkflowPreparePublication` 返回的 typed proof receipt identities 与显式 publication authorization，调用 publish 一次，随后调用 `WorkflowCompleteAuthoring(outcome=published)` 返回 component 生成的 terminal receipt。没有授权时直接使用 ready receipt 展示发布预览并停止。允许工具仅 workflow typed-receipt/status/publish。

最终 proof 已由 preparation command 绑定同一 content revision/bundle digest；其中 static projection 是必需但 non-effectful，acceptance disposition 是独立 receipt。releasing 不再 validate/dry-run/read full summary。publish 返回 precondition diagnostic 时只回 testing 重新 prepare 一次，不重复提交同一 publish，也不凭 summary 文本猜测 revision 已对齐。
