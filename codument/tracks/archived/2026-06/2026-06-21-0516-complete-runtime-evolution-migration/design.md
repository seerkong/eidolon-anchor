## 上下文

mission Track-9 收口，全层。scoping audit：大头已由前 8 track 完成；残留 = 1 处删 + pin upgrade + harness/resource + 2 命名回归。约束（mission 非目标）：不留 compat shim、不接受脏数据、不靠绕过；但 upgrade 必需的 legacy 迁移 reader 与拒绝守卫保留，新格式指针文件保留。决策：D1 隐私安全最小化 incident fixture；D2 聚焦 conformance harness；D3 沿用前 4 track 模式。

## 方案概览

1. 删 no-op MessageHistoryEffects shim（唯一真实删除）
  - 移除 `LocalFileMessageHistoryEffects.ts`、`MessageHistoryEffects` 端口类型/接线（`mod-ai-kernel/src/support/index.ts:22`）、executor 调用点（`AiAgentExecutor.ts:2656/:3271/:3362/:3475` 的 `appendMessage`/`backupHistory?.()`）。
  - 先红：源级断言 live 路径无该端口/调用；行为等价（端口本就 no-op，删后行为不变）。
2. session-upgrade-clean pin
  - 用真实形态 old-session fixture（含 transcript.txt + history-generations/*.json 形态）跑 `dryRunFileStoreAiRuntimeSessionUpgrade`→`applyFileStoreAiRuntimeSessionUpgrade`，断言 dry-run=upgraded、apply 后 `classifyFileStoreCheckpointPrefix`=clean。
3. 真实事故验收 harness + resource
  - resource：忠实最小化/脱敏 incident fixture（重现根因形态：completed effect 仅在 evidence 未配对进 conversation domain；old-format 文件形态），**不含**原始真实数据。
  - harness：升级该 fixture → recovery → 续一个 turn，断言 (a) 下一轮 provider context 含完整配对工具结果、不重复读同一文件；(b) 同一 loop 经 CLI/TUI/headless 产生等价 domain 真源。复用 backplane 的 RecoveryReadPort + surfaces 的 cross-surface 等价手法。
4. 4 维命名回归
  - repeat-read-file → 显式映射 `incident_005_recovery_replay.test.ts`。
  - TUI/CLI-divergence → 显式映射 `cross-surface-domain-equivalence.test.ts`。
  - pending-effect / history-lag → 补命名可执行回归（或显式映射 `runtime_data_conformance.test.ts:19/:90` 并加命名断言）。

## 影响范围与修改点（Impact）
- 删：`ai-support/.../LocalFileMessageHistoryEffects.ts`、`mod-ai-kernel/src/support/index.ts`（端口接线）、`AiAgentExecutor.ts`（调用点）。
- 验/新增测试：`ai-runtime-control-composer`（upgrade pin）、新增 incident resource + 聚焦验收 harness + pending-effect/history-lag 回归。

## 决策摘要
- 详见 `decisions.md`。D1 隐私安全最小化 incident fixture（不提交原始真实 session）；D2 聚焦 conformance harness（非全量 soak）；D3 沿用前 4 track 模式。

## 风险 / 权衡
- **风险**：删 MessageHistoryEffects 端口触及 executor 接线，若有隐藏非 no-op 路径会改行为。→ 缓解：先验证端口确为 no-op（audit 已确认）；先红源级断言，删后跑全量回归按名比对基线 0 新增。
- **风险**：session-upgrade-clean 依赖真实形态 fixture，形态不准则验不到。→ 缓解：fixture 按 audit 实证的真实 old-session 形态（transcript.txt + history-generations/*.json）构造。
- **风险**：CLI/TUI/headless harness 跨入口，flaky。→ 缓解：聚焦 conformance（单 turn replay + 等价断言），不做长 soak。

## 兼容性设计
- 删的是 no-op shim，无行为变化；迁移 reader/拒绝守卫/新格式指针文件保留。

## 迁移计划
- P1 删 no-op MessageHistoryEffects shim（先红→删→绿）。
- P2 session-upgrade-clean pin（真实形态 old-session fixture）。
- P3 真实事故 resource + CLI/TUI/headless 聚焦验收 harness。
- P4 4 维命名回归（映射 repeat-read/TUI-CLI；补 pending-effect/history-lag）。
- P5 全量回归（cell + terminal 按名比对基线）+ spec 覆盖 + 收尾。
- 回滚：各阶段独立，git revert 可逐阶段回退。

## 待解决问题
- pending-effect/history-lag 是新建独立回归还是给既有 conformance 加命名断言——P4 视既有覆盖强度定。
- incident fixture 的最小形态精度（多少文件足以重现根因 + 走通 upgrade）——P2/P3 定。
