# Operating protocol

读取已有 instance/status，明确 operation 与 input material，调用 run/resume/cancel，返回 run identity 和当前状态。没有 instance identity 时切回 deploying，按其桥接协议只创建一次 instance 后再返回 operating。`WorkflowRun` 若已经返回 `terminal=true` 与 output/error，该返回就是当前运行事实，直接向用户交付，不再 list、inspect 或重跑；只有 terminal=false 或用户明确要求 evidence detail 时才转 monitoring。失败保留 evidence。允许工具仅 workflow instance/status/run/resume/cancel；不得尝试 stage policy 未列出的工具。
