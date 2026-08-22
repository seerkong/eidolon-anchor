# skill: codument-archive-mission（归档 Mission）

归档 completed、cancelled 或 superseded Mission。Mission 不提升 behavior；各落地 Track 在自己的归档事务中维护 behavior authority。

## 主流程

1. 读取 Mission 状态、reports、Decision 与 bound Track 的实际生命周期。
2. 运行 `codument validate <mission-id> --strict`，并语义复核成功判据与收口证据。
3. 运行 `codument mission archive <mission-id>`。
4. CLI 报告 active 或 missing bound Track 时，issues-first 展示问题。用户可以先逐个运行 `codument-archive-track`，也可以明确允许保留这些引用后用 `--yes` 重试。
5. CLI 返回 `review-required` 时，按当前 Decision registry 规范补齐业务 owner 或迁移旧资源，再重试归档。
6. 报告归档路径、Decision 与 memory 晋升结果、保留的 linked-track issue。

CLI 负责 durable Decision transaction、rollback、日期路径冲突处理、Mission move、归档状态和 revision。系统找不到 CLI 时保持 blocked，不人工重演这些写操作。
