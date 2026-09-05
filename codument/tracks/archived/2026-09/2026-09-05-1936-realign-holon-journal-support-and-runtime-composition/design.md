# Holon 真实执行闭包迁移设计

## 旧逻辑映射

路径以 `cell/packages/` 为根，Terminal 另注。

| 原位置及职责 | 新 owner | 不变语义 |
|---|---|---|
| ai-organ-logic/src/organization/HolonTaskPumpJournal.ts:26–118，schema/记录/port/error | ai-organ-contract 的 journal 契约 | v1 intent/result、v2 subscription、legacy 读取 |
| 同文件:124–384，canonical identity/parse | ai-organ-logic journal 规则 | 字节序、digest、冲突与首次观测 |
| 同文件:384 起，immutable write、目录、锁、PID | ai-support 文件 journal 实现 | wx/fsync/link、超时、死进程恢复、effect 后故障点 |
| ai-support/src/organization/LocalHolonTaskRuntimeSupport.ts:156 起，admission/route/task/coordinator | ai-organ-logic HolonTaskRuntimeRoutes | scope、TaskSpace、订阅恢复和 actor mailbox |
| 同文件 ctor 与 retainSubmission:597 | ai-support 文件 task 工厂和 submission writer | FileTaskSpaceOwner、目录/fingerprint 原字节 |
| ai-support/src/organization/LocalHolonTaskRuntimeBootstrap.ts:39，挂载 service | organ capability 显式 bootstrap | 同 VM/scope 唯一 service owner |
| 同文件 openLocalHolonTaskRuntime:123 | Terminal organ 的实际应用装配 | admission、部署、actor recovery、close 顺序 |
| WorkflowRuntimeService 的 holonTaskRuntimeComposition | 真正 outer host 注入的 typed storage factory/composition | service 仅消费 port，不能自己选择文件实现；复用同一服务/路由 |

## 边界与装配

contract 不导入 logic/support。选择唯一拆法：logic 驱动 typed immutable-record store port，support 只负责字节存取、不可变写入和独占锁。subscribe/dispatch 的校验、首次观测、结果重放仍在 logic；clock/fault observer 是显式 runtime，supportRoot/lockTimeout 属于文件实现 config。不把业务规则注入 support 让其承载领域编排，也不让 support 导入 organ 取得默认规则。

store port 最小能力为 read/writeImmutable/list/withExclusive：记录集合是 subscriptions/intents/results 的闭合枚举，identity 由文件实现按原 fileKey 摘要寻址；read 返回字节，缺失仍抛原 ENOENT，只有 logic 的 readResult 按旧协议转 undefined；list 保留原排序，withExclusive 复用原锁协议。writeImmutable 的字节冲突错误保留，logic 仍裁决 subscription 的首次时间可重放。不得引入任意路径读写 port 或全能 filesystem 抽象。

route Processor 显式 runtime 持有 task owner、journal、submission writer、coordinator ownership 与 context maps；规则在 logic，物理效果在 support，核心不能 new 文件实现。保留公开方法形状可以减少无关变更，但 runtime 数据与业务函数须分离，不能把原 support 类简单搬家便声称完成。复用现有 coordinator actor/mailbox，不引入新调度器或 service locator。

使用既有 Terminal/Workflow 真实宿主，不新增空 capsule。删除 support 旧 bootstrap/route 回边，同步所有调用者；兼容出口不得借相对路径、延迟 import 隐藏反向边。

WorkflowRuntimeService 本身仍属于 logic，不把它改称宿主来豁免依赖。实际 Terminal bootstrap 显式将构造后的存储能力或 typed factory 注入 VM 的 Holon capability 实例；Workflow service 消费该实例字段。测试在 fixture 的 outer composition 做同样注入。无 Holon 能力的普通 workflow 不需要物理初始化；真正调用 Holon 而缺少依赖时明确拒绝，不新建全局 factory registry、默认懒导入或第二隐式定位器。原 getWorkflowRuntimeService 的缓存不扩张为物理实现选择入口。

## Authority、验证与风险

TaskSpace owner 裁决任务 transition；journal 保留 effect intent/result，不替代任务状态；route maps 仅是 live correlation。部署/actor session authority 不变。本 Track 不宣称 HolonDeploymentRuntimeStore 全部 IO 已归位，更不宣称全仓无环。剩余权限/config 回边由 G5 处理。

原 Holon characterization 是迁移基线。journal 与 route 可在不同文件上并行，P1-T3 集成公开出口与宿主；验收覆盖 v1/v2 字节、首次观测、幂等、恢复、独立/Ctrl/Data、shared/fresh 与 cold import。漂移先修复，不修改 golden、不放大超时。未运行 live provider 不声称 live 性能。
