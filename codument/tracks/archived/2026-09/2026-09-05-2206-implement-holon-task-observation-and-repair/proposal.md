# Holon 任务观察与修复

当前 assign 返回任务身份，但停止后缺少统一诊断和修复入口。增加 HolonTaskRuntimeService 的 task identity 观察/修复，并通过正式工具让人和 AI 共用。诊断包含状态、claim/attempt、member/session（未知明确为空）、最新进展及错误、可以执行的下一动作。

目标：非终态恢复唤醒；Failed/Cancelled 的重试或改派创建可审计的后继执行，保留原失败。作用于原 TaskSpace owner，不建第二套任务存储/调度器。新执行与外部 unknown acceptance 区分，不能隐式重放不确定 effect。CAS 与幂等冲突可见，重启后仍可追溯并继续修复。

非目标：让成功任务自动重复运行、覆盖旧任务终态、远程多节点、无证据的强制取消、动态任意能力注册。manual commit，不付费测试、不安装、不提交锁文件。

验收：`bun test cell/packages/ai-organ-logic/tests/workflow/holon_task_observation_repair.test.ts cell/packages/ai-organ-logic/tests/workflow/standalone_holon_task_runtime_file_e2e.test.ts`，再跑 Holon 工具相关回归。
