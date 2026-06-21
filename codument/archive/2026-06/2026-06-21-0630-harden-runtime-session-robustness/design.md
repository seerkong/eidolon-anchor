## 上下文
真实 session 调试副产物：三项独立健壮性改进。主 bug（单轮 repeat-read）独立后续。scoping audit 已钉死 seam（见 analysis/findings.md）。约束：守住「不快照不安全工具执行中」不变量、不破坏 observability 契约、不改 domain truth owner。实现按风险升序 a→c→b（决策 1）。

## 方案概览
1. (a) 恢复模型校验（SMALL）
  - 新增谓词 `isPersistedModelStillResolvable(modelConfig)`：读当前 providers（`llm-provider.json`）+ presets，校验 provider 存在**且** model 在该 provider 下（绕开 `flattenModelConfig` 的合成零化陷阱，参照 `assertKnownModelRef`）。
  - `TerminalRuntime.ts:1100` 与 `:1341` 守卫扩为 `if (!actor.modelConfig.model || !isPersistedModelStillResolvable(actor.modelConfig)) { actor.modelConfig = resolveConfiguredActorModelConfig() }`（后者已回退默认 preset）。
2. (c) journal hygiene（SMALL-MEDIUM）
  - lever1：`LocalFileOrchestrationHistoryEffects` 持内存序号计数器（首次惰性初始化一次，之后 O(1) 自增），`appendEvent` 不再每次调全量解析的 `nextOrchestrationSequence`。
  - lever2：体积轮转（达上限 rename 为带 timestamp 段、保留近 N 段，复用既有 helper）+ 丢弃/采样 idle no-op `hook_dispatch_report`（`finalAction:"continue"`/`elapsedMs:0`）。默认上限 64MB / 留 4 段。
3. (b) 超时落盘进度（MEDIUM；minimal-first）
  - `runInteractiveTurn` 超时分支（`AiAgentRuntimeCoordinator` 的超时返回点 + `saveSnapshotAfterProgress` 门控外）调既有独立 `flushConversationRuntimeToPersistence` seal 已完成对（已进内存 conversation domain），VM/ToolCallDomain in-flight 不动。
  - 恢复一致性子步：证明/调整恢复门（`RuntimeSnapshots.ts:269-298`）容忍 history 领先 VM snapshot；若需大改门则按决策 2 拆出、本项标 partial。

## 影响范围与修改点（Impact）
- (a)：`TerminalRuntime.ts`（守卫×2）、`ModelConfigOps.ts`（新谓词）。
- (c)：`LocalFileOrchestrationHistoryEffects.ts`（序号 + 轮转 + 过滤）。
- (b)：`AiAgentRuntimeCoordinator.ts`（超时分支 flush）、`RuntimeSnapshots.ts`（恢复门容忍）。

## 决策摘要
- 详见 `decisions.md`。D1 风险升序 a→c→b；D2 (b) minimal-first + 恢复门子步，过大则拆/标 partial；D3 沿用近 5 track 模式；D4 单轮 repeat-read 不在范围。

## 风险 / 权衡
- (a)：谓词误判（把有效 model 当失效→误覆盖）。→ 缓解：明确「provider 存在且 model 在 provider 下」才算可解析；测有效 model 保留 case。
- (c)：轮转/过滤误删有意义事件。→ 缓解：只过滤明确 idle no-op；轮转保留近 N 段；不破坏 observability 契约。
- (b)：history 领先 snapshot 致恢复不一致/损坏。→ 缓解：只 seal 已完成对、不动 in-flight；先证明恢复门容忍，过大则拆出标 partial（决策 2）。

## 兼容性设计
- (a) 有效持久化 model 不受影响；只在失效时回退。
- (c) journal 格式不变，仅序号来源 + 体积策略变；旧大文件可被轮转吸收。
- (b) 纯增量 seal，旧 session 恢复路径不变（除门容忍）。

## 迁移计划
- P1 (a) 恢复模型校验 + 回退（先红测试）。
- P2 (c) journal O(1) append + 轮转/过滤。
- P3 (b) 超时 flush 已完成进度 + 恢复门容忍子步（minimal-first，过大拆出标 partial）。
- P4 全量回归（cell + terminal 按名比对基线）+ spec 覆盖 + 收尾。
- 回滚：三项独立、可逐阶段 git revert。

## 待解决问题
- (b) 恢复门当前是否已容忍 conversation 领先 snapshot——P3 开始时实测定 MEDIUM/LARGE。
- (c) 轮转上限/段数默认值——P2 定（建议 64MB/4 段）。
