# 设计：优化长会话运行时性能

## 目标

消除长会话"越用越卡"：checkpoint 收尾（30~189s）、首 token 延迟、日志/快照/内存无界增长。核心思路：**有界化 + O(1)**——把"每次 checkpoint 全量解析数百 MB 日志"改为"读持久化 head"，把无界日志/工具记录/内存改为有上限。

## 现状与证据（详见 analysis/findings.md）

| 项 | 现场值 | 成本 |
|---|---|---|
| diagnostics.xnl | 674MB / 699,498 条 | 读 0.36s + parse 11.2s |
| ingress.xnl | 189MB / 692,508 条 | 读 0.1s + parse 3.2s |
| effects.xnl | 14MB / 23,297 条 | 读 0.01s + parse 0.22s |
| vm.json | 9.7MB（toolCallDomain 8.4MB / 4008 条） | 每次快照全量重写 |
| checkpoint start→finished | 56ms（会话初）→ 32~189s（近期） | 随日志线性增长 |
| eidolon 进程 RSS | 12.3GB | GC 压力 |

## 方案A：head/计数持久化（P0-1）

### head 文件 schema（`runtime-control/heads/<name>.json`）

```json
{
  "kind": "ingress_log",
  "count": 692508,
  "lastTag": "ContentDelta",
  "lastObservedAt": 1786158887785,
  "lastSequence": 173,
  "segments": [{ "name": "ingress.xnl", "count": 692508 }]
}
```

- 三类 head：`ingress_log`、`diagnostics_log`、`effect_evidence`（后者含 `lastSequence`）。
- 写入：复用 `writeJsonAtomically` 模式（temp + rename），由 append 路径在 append 成功后 O(1) 更新；**不在热路径上读日志正文**。
- 读取：`readRealSessionDurableHeads` 的 `ingress_log`/`diagnostics_log`、`readRuntimeControlEffectEvidenceSequence` 直接读 head。

### 旧会话回退（无 head 文件）

- 读最后 N MB（如 16MB），找到第一个"换行后以 `<` 开头"的合法 XNL 节点起始行，从该 offset 起 `parseXnl`（已实测：10MB 切片从 `\n<` 处解析 10,822 节点，与真实记录数完全一致，181ms）。
- 用记录内单调递增的 `sequence` 推算 count/last。
- 首次回退成功后即写入 head，后续走 O(1) 路径。

## 轮转（P0-2）

- 阈值 64MB/段，保留近 2 段：`ingress.xnl` → `ingress.xnl.1` → `ingress.xnl.2`（最旧删除）。
- 触发点：append 前检查当前段大小（`stat`），超限切段。
- head 的 `segments` 只记录能精确证明的段 count，`count` 为累计；旧 rotated 段仅有有界 tail、无法证明段内精确 count 时可从 `segments` 省略，但文件继续保留，后续 append/轮转不得把未知 count 捏造为 0 或累计总数；轮转不影响 last 信息。

## 增量快照写（P1-1，保持频率）

- `saveAiAgentRuntimeSnapshot` 维护自上次快照以来的脏 actor/fiber 集合。
- `LocalFileRuntimeSnapshotRepository.writeSnapshot` 仅写脏 actor/fiber 文件；派生索引/问卷/manifest 全量写（小文件）。
- vm.json 在 P1-2 有界化后仍全量重写（秒级以内，已足够便宜）。

## ToolCallDomain 保留与外部化（P1-2）

- `ToolCallDomainRuntime` 增加可配置的 `retain({ terminalRecordLimit })` 操作：始终保留全部非终态记录，仅保留最近 N 条终态记录，其余裁剪。终态新旧顺序按终态时间降序、`plannedAt` 降序、`toolCallId` 字典序升序确定；裁剪不改变其余记录原有的插入顺序。
- 默认 `terminalRecordLimit=20`，对齐 `compact.microCompact.cheap.microKeepRecentToolResults=20`。现场 `vm.json` 的 4008 条记录中 4007 条已终态、仅 1 条非终态；默认窗口会把终态历史从 4007 条有界到 20 条，同时保留正常压缩路径认为应保持近期可见的工具结果。调用方仍可按恢复/运维需求显式调整。
- 外部化阈值与预览长度直接派生自 `compact.microCompact.budget`：默认分别为 `toolResultPersistThresholdBytes=30000` bytes 与 `toolResultPreviewChars=2000` chars；VM 注入的 runtime config 可覆盖。`outputText` 的 UTF-8 byte size 严格大于阈值时写入 `artifacts/tool-results/<actor>/<toolCallId>-<hash>.txt`。
- 持久化 record 删除 `outputText`，仅保留 `{ kind: "artifact_ref", assetId, preview, size, digest }`；`assetId` 是 session-relative POSIX path，`digest` 为完整 `sha256:<hex>`，恢复时同时校验 byte size 与 digest，避免静默接受缺失/损坏 artifact。旧快照中内联的 `outputText` 保持兼容。
- 快照边界先从 live domain 构造独立持久化视图，按 T4.1 规则保留全部非终态 + 最近 20 条终态，仅对入选记录写 artifact，再写有界 `vm.json`。checkpoint 成功返回后才对 live domain 调用 retention；写入失败或 checkpoint 未提交时不提前丢弃运行期事实。
- `reconstructToolResultsFromDomain` 与 cooperative interrupted-tool recovery 都携带 `sessionDir` 解析 artifact 引用并重建完整输出。由此持久化视图与 live domain 的记录数均有界，同时恢复仍得到全文。

## 内存有界（P1-3）

- T6.1 确认 `depa-data-graph-core@1.0.1` 的 timeline 不提供 retention 且 `dispose()` 不清 entry；T6.2 在 `symbiont-contract` 提供 `BoundedTimeline`/`BoundedEventLog`。实现使用固定容量环形窗口，序号持续单调，append 仍按订阅注册顺序同步 fan-out，dispose 会实际释放 replay payload。
- `IngressStreams.timeline`/tee channels、`SemanticStreamGraph.eventLog`、`AgentEventGraph.eventLog`、`MessageHistoryGraph.inputLog` 与 VM Rx 的 `semantic/history/prompt/session/observability/observabilityError/controlSignal` 七个 live transport log 均使用 `LIVE_EVENT_REPLAY_LIMIT=0`。这些 owner 的现有消费者均在生产前订阅且不请求历史 replay；已同步投递的 entry 不承担恢复职责。
- `MessageHistoryGraph` 的 projection state 与输入 log 分离，未结算 assistant/tool assembly 继续完整保留。仅用于孤儿结果诊断的 `seenToolCallIds` 保留最近 4096 个不同 ID，避免异常路径中大量未配对调用导致独立线性增长；该窗口不参与消息提交或恢复。
- `createObservableGraph.traceLog` 是显式可读的诊断历史，保留最近 1000 条；仅向 diagnostic pipeline 转发、无读取者的内部 `traceTimeline` 使用零历史。DiagnosticPipeline 既有 per-node 100 条边界不变。
- 恢复权威保持在 conversation domain/files、runtime snapshot 与 effect evidence；bounded live logs 不用于 recovery replay。恢复与单向 conversation handoff 的定向回归保持通过。
- conversation domain 的 event/assembly arrays 已有 500/400/300 上限；materialized history/prompt/session state 是恢复与行为权威，不允许套用 transport-log 直接删除。后续若仍占主导，只能对已 sealed、已持久化且不在 active prompt/history lineage 的 generation 做 lazy-load/卸载。
- 长跑验证以 retained count 为主、GC 后 heap 为辅助：50k/200k 输入后 session semantic chain 与 VM 七日志都保留 0 条，observable trace 固定 1000 条。现场旧 PID 已不存在，未取得同一进程 RSS/heap 曲线，因此仍不把历史 12.3GB RSS 分配给任何 owner。
- 运维建议：上线该版本时重启现有长会话进程，以释放旧实现已经积累的 timeline arrays。上线后不再为这些 owner 设置固定周期重启；持续监控 RSS、heap used、GC pause 与 bounded owner count，只有 RSS/GC 持续越过项目告警阈值时执行受控重启并采集同一时点 heap snapshot。没有生产数据前不虚构固定小时数或 RSS 阈值。

## 决策摘要

- 详见 `decisions.xnl`。已确认：单 track；manual 提交；终态 phase GapLoop(max-rounds=5, on-exhausted=block)；终态 phase AttractorCheck(coding)；P0-1 方案A；P0-2 按大小轮转；P1-1 保持频率仅增量写。

## 风险 / 权衡

- head 与日志短暂不一致（崩溃窗口）→ 回退路径兜底 + 恢复仍以日志/effects 为权威。
- 轮转丢旧诊断 → 诊断/ingress 非恢复必需。
- 裁剪 toolCallDomain 影响恢复重建 → artifact 引用 + 预览兜底。
- 增量写脏集正确性 → 测试覆盖 + manifest 校验。

## 兼容性设计

- head 可选；缺失回退旧行为。轮转段命名不与现有冲突。旧会话首跑自动生成 head。

## 迁移计划

- 旧会话自动：首次 checkpoint/append 回退解析生成 head；轮转对新写入生效。
- 回滚：删 head 即回退；轮转可配置关闭。

## 待解决问题

- 生产部署后仍需采集同一活跃进程的 RSS、heap snapshot 与 GC pause 曲线，以判断 conversation materialized durable state 或第三方 runtime 是否成为新的主导 owner；这不影响 live timeline 的精确容量上界。
