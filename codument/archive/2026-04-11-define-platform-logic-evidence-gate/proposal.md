# 变更：定义 platform-logic 引入的证据门槛

## 背景和动机

`platform-microkernel-feasibility-analysis.md` 明确反对为了“未来可能复用”提前抽空泛平台抽象。

当前虽然已有 `platform-contract`、`platform-support`、`mod-platform-kernel`，但还没有足够证据说明必须立即引入独立 `platform-logic` 包。下一步更合理的是先定义证据门槛，而不是仓促实现。

## 要做

- 定义何种跨领域复用证据才允许引入 `platform-logic`
- 明确哪些候选能力当前仍应留在现有宿主
- 建立禁止“无证据先抽象” 的治理规则

## 不做

- 本次不实现 `platform-logic`
- 本次不为了结构完整而制造空平台层

## 影响范围

- `codument/archive/2026-04-11-refactor-platform-kernel-and-ai-domain-kernel/analysis/platform-microkernel-feasibility-analysis.md`
- 后续平台微内核扩展策略
- focused governance docs/tests（如需要）
