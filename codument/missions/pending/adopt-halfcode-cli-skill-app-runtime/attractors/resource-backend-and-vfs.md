# AT2 资源后端与 VFS 语义

> 本吸引子是本 mission 的核心技术约束：它直接对应历史会话中用户点名的「eidolon 中使用的虚拟文件系统」这一关键 gap。

## 断点

Halfcode 公共包的资源访问能力当前是两层，都不足以承接 Eidolon 的 Effective VFS：

- `ResourceEffect`（`cli-host-contract/src/resource.ts`）：`stat` / `readDirectory` / `readText` / `readBytes`，**只读**，无逻辑 URI、无 revision。
- `WorkspacePort`（`skill-app-contract-public/src/host.ts`）：`exists` / `kind` / `readText` / `writeText` / `writeTextAtomic` / `makeDirectory` / `copy` / `remove`，**面向操作系统文件**，无 revision、无整包提交、无发布回执。

后果：Skill App 从磁盘包加载、却要读取和编辑 Eidolon VFS 时无法工作；只替换 `readText/writeText` 而保留底层物理目录假设，会重演既有的「业务操作支持 VFS、加载器仍要物理目录」故障。

## 三层语义

| 层 | 数据与操作 | 通用部分归 Halfcode | 具体裁决归 Eidolon |
|---|---|---|---|
| 资源读取 | 逻辑 URI、稳定 identity、bytes、类型、来源、revision；stat/list/read 与依赖读取 | 接口与协议 | 指定 revision 的 Effective VFS 只读端口 |
| 草稿编辑 | base/work、结构 mutation、文件 create/update/delete/move、working revision | 接口与协议 | Session 的可恢复候选工作区 |
| 发布准入 | expected revision、完整候选、proof、提交关联、receipt、query/recover | 协议与回执形状 | 当前 authority 的 prepare/admit/CAS |

## 不变量

1. 统一契约**不要求**各后端拥有相同能力；未提供事务提交的后端必须返回 capability unavailable，**不得伪造 CAS**。
2. 资源发现、依赖解析、候选校验与代码材料加载必须使用选定来源及其闭包；只换读写函数不算接通。
3. 执行器需要磁盘材料时，从已校验闭包生成受控缓存并校验 identity/digest；**缓存不是可反写的资源 authority**。
4. Skill App 自身的来源与它编辑的目标资源可以不同，两者不共享隐含 root。调用不得另建一份空 VFS 冒充运行中的 Eidolon。
5. 已准备好的候选绑定 base revision、working revision、完整材料摘要、contract lock、校验证据与授权依据。任一相关输入变化即失效，需重新 prepare。
6. 持久 authority 提交与磁盘投影是两个阶段。准入成功但投影未完成必须如实上报并可恢复，**不能靠重复发布掩盖结果不确定**。
7. 动态加载记录本次操作的 FQN、source/material digest 与契约版本；热更新不等于在运行中替换处理函数。

## 排除集

- 把 VFS 逻辑 URI 降级为物理路径后直接写入。
- 用多次 rename 宣称跨介质整体原子性。
- 发布超时后直接重发副作用（应先按 publication/operation ID 查询事实）。
- 在 CLI 进程内另建一份 VFS 冒充当前运行实例的资源状态。
