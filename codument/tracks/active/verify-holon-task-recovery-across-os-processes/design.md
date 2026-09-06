# 跨进程恢复设计

## 基线与 owner

当前 HolonTaskRuntimeComposition 组合唯一 service/coordinator，ai-support/LocalHolonTaskRuntimeSupport 创建物理 storage，FileHolonTaskPumpJournalStore 执行 durable IO；不恢复已移除的 logic→support 依赖。

TaskSpace 是任务 authority；journal 是 dispatch 恢复材料；external ledger 是外部执行 authority。测试子进程的 member Map 可以重新创建，但外部已执行事实不得共用 Map。父进程只注入 workspace 路径、场景名并收集退出码/PID/最终观察，不伪造任务快照。

## 故障窗口

1. none assignment 后退出，验证 durable subscription 可以重新唤醒。
2. 已写 intent、effect 尚未接受时直接结束子进程，不运行 finally。
3. adapter 已持久接受、journal result 尚未记录时直接结束进程。
4. TaskSpace 已 settle、调用方尚未观察时结束进程。

B 重新装配原 owner，从磁盘恢复并重复恢复；读取 task terminal receipt，验证 output 和 ledger 接受次数。对子进程设有限测试超时并清理自建临时目录。不杀用户进程。锁等待按真实 owner 生命周期，不能以删全部锁来让测试通过。

## 边界与验证

先扩充 characterization 测试，出现失败才修改对应生产闭包。不为 fixture 建通用 scheduler/控制器。幂等保证以外部适配器支持同 key 协议为条件，未知 acceptance 不宣称 exactly-once。

本 Track 暂无领域结构变更，故不创建空 modeling delta；如修复改变 owner/状态机则补目标态 delta。阶段 GapLoop + verify_round=true，设计后 coding AttractorCheck。任务及阶段使用同一 proposal 验证命令，避免只检查文件存在。
