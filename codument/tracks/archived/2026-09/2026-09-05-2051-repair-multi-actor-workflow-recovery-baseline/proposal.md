# 修复多 Actor Workflow 恢复基线

本 Track 承接 Mission G6-T0 的既有基线 B1，不属于机械搬迁：同一父 Workflow 自主组合 SubFlow、选用及创作 Worker 资源的恢复用例，在改造前后均因 provider_context_transition_head_session_divergence_conflict 失败。2026-09-05 独立运行原用例再次失败（约 10 秒），不能以超时放宽或删除断言验收。

目标是让不同 Actor 的正常持久推进可以交错，同时保留同 Actor 前驱、损坏记录、双 authority 等 fail-closed 保护。只修改被证明有误的 receipt/head 判定及必要 repository 读 port；不改变 provider 协议、Prompt 内容、持久格式或 Workflow 编排设计。

成功判据：原 B1 不改语义即可通过；新增两个 Actor 交错/恢复及损坏反例；完整 Conversation、Context、Holon 矩阵与 noEmit 全绿。手动提交，不构建安装或发布，不跟踪 bun.lock。
