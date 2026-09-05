# Holon journal 与本地装配归位

## 目标

现有 organ journal 同时持有记录规则与文件锁/写入，support 又反向导入 organ 的 profile/coordinator/route/bootstrap，形成真实环。保持成熟算法，将契约、规则、文件效果、宿主组合归位。

## 兼容与范围

内部 API/import 可以调整并同步全部消费者；持久目录、版本、字节、摘要、错误、首次观测和幂等键不变。独立与 Ctrl/Data Workflow 继续使用同一 task 服务；不新增任务真源或调度器。

不新增空 capsule，不全库改名，不改 golden 接受漂移，不处理已登记的 provider-context B1（Mission G6）。manual，不构建、安装、发布，不跟踪 bun.lock。

## 验证

`bun cell/scripts/runtimeClosureRegression.ts holon`、安装的 TypeScript 5.9.3 对 `cell/tsconfig.holon-task-runtime.json --noEmit`；新增边界/替代依赖测试。阶段 fresh GapLoop 与 coding AttractorCheck。
