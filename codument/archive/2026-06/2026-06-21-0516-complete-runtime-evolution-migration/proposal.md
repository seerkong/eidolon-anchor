# 变更：运行时演进收口迁移（complete-runtime-evolution-migration）

## 背景和动机 (Context And Why)

runtime-evolution mission Track-9（W4 收口，全层）。对应 005「对当前问题的重新解释」「005 相对 003 的关键修正」「下一步建议」。前置 #1–#8 全部归档（data-subgraph contracts、profile/capability boundary、control component boundaries、semantic spine、turn/tool/provider lifecycle、persistent-session-backplane、isolate-runtime-projection-surfaces、ai-multi-agent-domain-integration）；gate `G-migration-incident` 原 partial（真实事故有证据但最终 harness 需前序）——前序已 landed，解除阻塞。

独立 scoping audit（见 `analysis/findings.md`）确认：**收口大头已由前 8 条 track 做完**——旧 transcript/json/jsonl append-only 写路径已删、upgrade dry-run/apply 机制已存在、005 最小化 replay + cross-surface equivalence 测试已落地。Track-9 是 **bounded 收尾**：唯一一处真实删除（no-op `MessageHistoryEffects` shim）、pin session-upgrade-clean、补真实事故验收 harness + 忠实最小化 incident resource、补 pending-effect/history-lag 命名回归。这是整条 mission 的最终一致性验收。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 删除唯一残留的 compat shim：no-op `LocalFileMessageHistoryEffects` + 其 `MessageHistoryEffects` 端口跳板与 executor 调用点。
- pin session upgrade dry-run/apply：对真实形态 old session 升级后校验 `clean`。
- 提供重现真实事故形态的 conversation resource（隐私安全：忠实最小化/脱敏 fixture，**不含**原始真实 session 数据）+ CLI/TUI/headless 聚焦验收 harness（升级→恢复→续 turn，断言根因不复现 + 跨表现等价）。
- 4 个命名回归各有可执行守护：repeat-read-file、pending-effect、history-lag、TUI/CLI-divergence（已覆盖的显式映射，缺失的补）。

**非目标:**
- 不保留任何 compat shim（但 upgrade 必需的 legacy 迁移 reader、transcript-only 拒绝守卫**不是** shim，保留）。
- 不支持脏数据作为正常输入（保留拒绝守卫）。
- 不通过 compaction/guardrail/禁用工具绕过问题。
- 不提交原始真实用户 session 数据（隐私）；不做全量长运行 soak（聚焦 conformance 即可）。
- 不删新格式 `*.index.json`/`artifactRefs.json` 指针文件；不动 domain truth owner / prompt build / surface rendering。

## 变更内容（What Changes）
- **BREAKING（内部端口）**：移除 `LocalFileMessageHistoryEffects` + `MessageHistoryEffects` 端口（`mod-ai-kernel` 接线）+ executor 的 `appendMessage`/`backupHistory?.()` 调用点。
- 新增 session-upgrade-clean pin 测试（对真实形态 old-session fixture）。
- 新增真实事故形态 conformance resource（最小化/脱敏）+ CLI/TUI/headless 聚焦验收 harness。
- 补 pending-effect / history-lag 命名回归；显式映射 repeat-read-file（incident_005 replay）/ TUI-CLI-divergence（cross-surface equivalence）。

## 影响范围（Impact）
- 受影响能力（behaviors）：`complete-runtime-evolution-migration`（新，收口）。
- 受影响代码：`cell/packages/ai-support/.../LocalFileMessageHistoryEffects.ts`（删）、`mod-ai-kernel/src/support/index.ts`（端口接线删）、`cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`（调用点删）、`ai-runtime-control-composer`（upgrade，verify）、新增 harness/resource/regression 测试。
- 相邻：无（最后一条 mission track）。
