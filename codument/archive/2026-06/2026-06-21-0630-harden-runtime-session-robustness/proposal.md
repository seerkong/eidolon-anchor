# 变更：运行时会话健壮性加固（runtime-session-robustness）

## 背景和动机 (Context And Why)

真实老 session（`sparrow-agents/.eidolon/sessions/20260604001602__...`）headless `eidolon exec "请继续"` 续跑不收口。深度调试（含真机重跑）定位出多个独立问题：

- **主 bug = 单轮内 repeat-read 非收口**（模型在一个连续 turn 内反复发同样工具调用、永不产出最终答复）——这是更难的根因，**留作独立后续排查，不在本 track**。
- 本 track 做调试中识别到的**三项较小、独立的健壮性改进**（scoping audit 已钉死 file:line seam）：(a) 恢复时校验持久化模型、缺失回退默认 preset；(b) 超时/mandatory_continuation 的 turn 落盘已完成进度（续跑接力而非重启）；(c) observability journal O(n²) append 修复 + 体积轮转。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- (a) 恢复时若持久化 model/provider 在当前配置不可解析，回退默认 preset；可解析则保留。
- (c) journal append 改 O(1)（内存序号，去全量重解析）+ 体积上限/轮转 + idle no-op 事件可丢弃。
- (b) 超时（mandatory_continuation）时 seal 已完成 conversation 进度，使续跑接力；只 seal 已完成部分、不快照 in-flight。

**非目标:**
- **不**修单轮内 repeat-read 非收口（独立后续 track）。(b) 明确不治单轮 loop。
- **不**破坏「不快照不安全工具执行中」不变量；不破坏 observability 契约；不改 domain truth owner。
- 若 (b) 的恢复门一致性改造证明为 LARGE/触及不变量，拆为后续 track，本 track 标 partial（见 decisions 2）。

## 变更内容（What Changes）
- (a) `TerminalRuntime.ts:1099-1102/1340-1343` 守卫扩为「空 **或** 持久化 model 不可解析」→ 回退默认；新增 `isPersistedModelStillResolvable` 谓词（查 providers+presets）。
- (c) `LocalFileOrchestrationHistoryEffects.ts`：内存序号计数器替换 per-append 全量解析；加体积轮转（默认 64MB/留近 4 段）+ idle no-op 过滤。
- (b) 从 `runInteractiveTurn` 超时分支调既有 `flushConversationRuntimeToPersistence` seal 完成对；恢复门容忍 conversation 领先 snapshot。

## 影响范围（Impact）
- 受影响能力（behaviors）：`runtime-session-robustness`（新）。
- 受影响代码：`terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`、`cell/packages/ai-organ-logic/src/llm/ModelConfigOps.ts`（(a)）；`cell/packages/ai-support/src/runtime/LocalFileOrchestrationHistoryEffects.ts`（(c)）；`cell/packages/ai-organ-logic/src/runtime/AiAgentRuntimeCoordinator.ts` + `persistence/RuntimeSnapshots.ts`（(b)）。
- 相邻：单轮内 repeat-read 排查（独立后续）。
