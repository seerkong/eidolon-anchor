# 变更：优化长会话运行时性能（P0-1 ~ P1-3）

> track: `optimize-session-runtime-performance`（pending，等待批准）

## 背景和动机 (Context And Why)

现场 session（`E:\game-dev\yxts-web-bun\.eidolon\sessions\20260804031100__01KZ4GJNQ4G4Y6Y1R8021M7WXM`）运行 4 天后明显变卡：

- 发一段文字后要等很久才出流式输出；
- 流式输出结束后，要等很久才从"进行中"变"停止"。

排查结论（证据见 `analysis/findings.md`）：

1. **每次 checkpoint 全量解析日志**：`runFileStoreAiRuntimeConcreteCheckpoint` 每次调用 `readRealSessionHeads()`（`cell/packages/ai-runtime-control-composer/src/index.ts:371/413`）→ `readRealSessionDurableHeads`（`cell/packages/ai-file-store-logic/src/index.ts:1199`）→ `readRuntimeControlXnlReplayEvents` 对 `ingress.xnl`(189MB) 与 `diagnostics.xnl`(674MB) **readFile+parseXnl 全部**。实测单次约 15s，checkpoint 内调用 2 次 ≈ 30s+；start→finished 间隔从会话开始 56ms 涨到近期 32~189s，随日志线性增长。
2. **日志逐 token 无界增长**：`diagnostics.xnl`/`ingress.xnl` 每个 think/content/tool 增量都落盘（约 0.96KB/条），活跃日约 0.5GB/天，合计已 863MB、140 万节点。
3. **effect 序号 O(n)**：`appendRuntimeControlEffectEvidenceEnvelope`（`ai-file-store-logic/src/index.ts:1363`）每次 append 前 `readRuntimeControlEffectEvidenceSequence` 全量解析 `effects.xnl`(14MB)。
4. **vm.json 膨胀**：`toolCallDomain` 4008 条记录（含完整 bash 输出）8.4MB，永不清理，每次快照全量重写。
5. **进程内存无界**：eidolon 进程 RSS 12.3GB（WorkingSet64），GC 压力放大所有延迟。

## 目标 (Goals)

- **P0-1（方案A）**：head/计数持久化——在 `runtime-control/heads/` 维护 ingress/diagnostics/effect-evidence 的持久化 head；读取 head / 取 effect 序号为 O(1)，不再整读日志；旧会话无 head 文件时回退"有界尾部窗口从合法 XNL 节点起始行解析"。
- **P0-2**：`ingress.xnl`/`diagnostics.xnl` 按大小轮转（64MB/段，保留近 2 段）。
- **P1-1**：保持现有快照频率不变，仅做**增量写**（未变化的 actor/fiber 文件不重写）。
- **P1-2**：ToolCallDomain 保留窗口（活跃 + 最近 N 终态），大 `outputText` 外部化到 `artifacts/tool-results/`，vm.json 有界。
- **P1-3**：内存有界——审计并裁剪 ingress 时间线/语义事件图/消息历史图等无界保留点。

## 非目标 (Non-Goals)

- 不改 checkpoint 触发频率（P1-1 保持现状，仅增量写）。
- 不做 effects.xnl 的轮转（它是恢复所需的 effect-evidence WAL；本 track 只保证其序号读取 O(1)）。
- 不做 UI/前端改动；不改 LLM provider 协议。

## 变更内容 (What Changes)

- `cell/packages/ai-file-store-logic/src/index.ts`：head schema/读写器、append 路径 O(1) 更新 head、轮转切段、`readRealSessionDurableHeads`/`readRuntimeControlEffectEvidenceSequence` 改读 head + 旧会话回退。
- `cell/packages/ai-runtime-control-support/src/index.ts`、`cell/packages/ai-runtime-control-composer/src/index.ts`：checkpoint head 解析走持久化 head。
- `cell/packages/ai-organ-logic/src/runtime/ToolCallDomainRuntime.ts`：保留窗口 + 输出外部化引用。
- `cell/packages/ai-support/src/runtime/LocalFileRuntimeSnapshotRepository.ts`、`cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`：增量快照写（脏 actor/fiber）。
- `cell/packages/ai-organ-logic/src/stream/`、`cell/packages/symbiont-logic/src/stream/`：内存保留点裁剪（P1-3）。

## 影响范围 (Impact)

- 行为能力：`runtime-session-robustness`、`ai-runtime-control-engine-adoption`、`aiagent-persistence-recovery`、`tool-call-domain-lifecycle`。
- 持久化布局：新增 `runtime-control/heads/*.json`；日志出现轮转段（`.1`/`.2`）；旧会话首次运行自动生成 head。
- 兼容性：旧会话无 head 文件时回退解析路径，行为等价；轮转对恢复（依赖 effects.xnl + vm.json + conversation）无影响。

## 决策摘要

- 详见 `codument/tracks/pending/optimize-session-runtime-performance/decisions.xnl`
- 关键结论：一个 track 收编 P0~P1 全部；CommitMode=manual；校验=终态 phase GapLoop（max-rounds=5, on-exhausted=block）；方向审查=终态 phase AttractorCheck(coding)；P0-1 用方案A（head 落 `runtime-control/heads/` + 旧会话尾部窗口回退）；P0-2 按大小轮转；P1-1 保持频率仅增量写。

## 风险 / 权衡

- head 文件与日志不一致（append 崩溃）→ head 更新在 append 成功后进行，且旧会话回退路径兜底；recovery 仍以日志/effects 为准。
- 轮转丢失旧诊断日志 → 诊断/ingress 为可重建观测数据，非恢复必需；保留近 2 段 + head 计数。
- ToolCallDomain 裁剪影响恢复重建 → 外部化引用 + 预览保证 `reconstructToolResultsFromDomain` 可重建。
- 增量写引入"脏集"状态 → 以 manifest/mtime 校验，恢复语义不变。

## 兼容性设计

- 新增 head 文件为可选加速；缺失时回退路径与旧行为一致。
- 日志轮转段命名不与现有文件冲突（`<base>.1`/`<base>.2`）。
- vm.json/toolCallDomain 裁剪只影响持久化视图，运行期 domain 保留窗口由实现决定。

## 迁移计划

- 旧会话：首次 checkpoint/append 时生成 head（回退解析初始化）；轮转仅对新写入生效。
- 回滚：head 文件可删（回退路径自动启用）；轮转开关可关。

## 待解决问题

- ToolCallDomain 保留窗口的默认 N 与外部化阈值取值（实现期以 vm.json 现场数据定标，默认对齐现有 `compact.microCompact` 预算）。
- P1-3 内存裁剪点清单需审计后确认（P6）。