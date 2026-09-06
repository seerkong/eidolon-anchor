# 真实 OS 进程间 Holon 任务恢复

现有 fresh VM 测试共用外部 accepted Map，不能证明进程退出后的恢复。建立两个独立 Bun 子进程，以真实 FileTaskSpaceOwner、journal、subscription 与独立文件 effect ledger 交接。

目标：覆盖 pending、intent-before-dispatch、accepted-before-result、settlement-before-observation；PID 独立、恢复成功、外部同 key 接受一次、重复恢复不增加 effect。非目标：付费 provider、远程分布式 exactly-once、新任务状态库、架构全库迁移。

验收命令：`bun test cell/packages/ai-organ-logic/tests/workflow/standalone_holon_task_runtime_file_e2e.test.ts cell/packages/ai-organ-logic/tests/workflow/holon_task_os_process_recovery.test.ts`。

影响：测试 fixture，以及实证发现的 journal/storage 恢复缺陷。保持 manual commit，不 build/install/publish，不跟踪 bun.lock。
