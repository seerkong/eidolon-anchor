# owner-backed 观察与修复

## 现有到目标

HolonTaskRuntimeService 现有 assign 使用 catalog/deployment/taskSpace/coordinatorMailbox/settlement ports。扩展观察与修复 port，经 Capability 按明确 admission + task identity 路由，不能依赖进程内 taskAdmissions Map 才能观察恢复后的任务。

HolonTaskRuntimeRoutes 已持有 FileTaskSpaceOwner、journal、binding 与 member runtime。诊断从 owner snapshot/history、subscription、journal 和 member owner 派生，暴露状态/attempt/lease/最后事件/失败及可用动作。未知会话引用不猜测，空值须有原因。background wake error 是观测，不可自行改变 TaskSpace 终态。

## 修复语义

恢复（resume）仅经 coordinator mailbox 重唤已有任务，不先创建新 attempt；采用既有 intent/result 与外部同 key 契约。已经 Failed/Cancelled 不可回写 Ready，使用 task-manager 原生 replan 在同一 TaskSpace 加后继 task；旧 definition/profile/relations 不变。改派时新任务冻结目标 admission，原任务保持旧身份。

修复 lineage、原任务/原revision、原因/动作/request identity 必须作为持久 task artifact 或既有 owner receipt 保存，不另建 JSON 可变状态 authority。新任务不依赖 Failed 前驱的 succeeded 条件；lineage 不是可执行 dependency。request id 重放验证原证据与内容 digest，不能只凭同 id 静默接受不同请求。

TaskSpace replan 与 journal subscription 非原子，必须用持久事实证明并恢复中断窗口：重启可从已知 TaskSpace 与新任务修复 artifact 重建缺失 subscription；不能仅在内存记关联。活跃任务不自动强制改派；external acceptance unknown 时明确要求观察/协调，用户选择显式新执行才可产生新 effect。

具体原子边界：replanTask 的同一 owner command 同时传入新 task 的 inputArtifact ref 与 artifactBodies，artifact 包含修复 request fingerprint、源 task/revision、目标 frozen admission、完整 subscription/input 与配置；owner 的 admitted snapshot+receipt 为提交证据。重启只扫描已有 subscription 可定位的 TaskSpace，只有 snapshot 已引用且有对应 replan receipt 的 artifact 可发布缺失 subscription，未提交孤立 artifact 不生效。先读已接受修复 artifact 验证 request fingerprint 才重放，禁止用新 snapshot 重算旧 replan command。

Canonical subscription 的 invocation 粒度为单 task：HolonTaskSpacePump 对新 EIDOLON_HOLON_TASK_PROFILE_KIND 须同时检查 task.taskId === subscription.taskId，不能仅按 admission/binding 扫描同空间全部 task。每个 successor 有独立 subscription。旧 legacy organization profile 的 batch 行为保持并单独回归；不让旧 subscription 把源 input 送给后继。测试必须使用源/后继不同 input 与两个同admission任务证实隔离。

## 产品入口和测试

新增正式工具调用 observation/repair，与服务公开 API 共用，输入 selector 与 invocation 分开；read-only 不调用 model。文档给出身份、动作、预期返回和不可自动修复边界。增量保持现有 assign API 兼容。

测试：pending/active/terminal、未知任务/错admission、错误与session显示、resume、失败后继、改派、同request重放、异内容冲突、stale revision、发布中断恢复、旧失败不变；由真实 file owner验收并保留现有 final/none/stream。modeling/engineering 显式关闭。阶段 GapLoop + verify_round=true，设计后 coding AttractorCheck。
