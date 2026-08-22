先依据 `sys-eidolon-anchor-devops` 根路由选择 stage，再调用 `WorkflowLoadStageContext` 加载该 stage 的系统上下文。需要专属操作或领域标准时，用通用 `Skill` 读取精确 sibling resource；切换 stage 时重新加载，禁止递归调用 WorkflowFulfill 或 WorkflowAuthor。
