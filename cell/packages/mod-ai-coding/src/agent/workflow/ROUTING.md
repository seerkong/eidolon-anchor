先依据 `sys-ai-workflow` 根路由选择 stage，再调用 `WorkflowLoadStageContext` 加载该 stage 的系统上下文。切换 stage 时重新加载；禁止递归调用 WorkflowFulfill 或 WorkflowAuthor。
