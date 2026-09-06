# 反馈驱动的 Agent/Context 资源修订

已有动态 author-new 与 select-existing，增量不是再实现 create，而是让有证据的运行失败驱动配方新版本，并让 ContextPipeline 实际执行 Halfcode 管理的代码。当前 adapter create-only，executor 只检查 standard descriptor，这些是待补缺口。

目标：保留原成熟消息编译链，使用 Halfcode 原生 authoring update、Effective VFS fence 与 reconcile；修订带反馈因果，old run 固定完整执行依赖，新版本用于后续 run。测试覆盖冲突拒绝、crash/reconcile、旧闭包恢复、稳定 prefix 不随动态反馈变化。

非目标：新资源管理库、全线替换旧 Agent、动态扩展所有 capability、付费模型或发布安装。潜在跨系统缺口必须交原 owner，不在 Eidolon 复制通用协议。manual commit；bun.lock 不跟踪。

验收入口由 P1-T1 在 design 写入定位后的真实测试命令，P1-T2 使用这些测试完成原子验收；不得以文档存在代替代码验证。
