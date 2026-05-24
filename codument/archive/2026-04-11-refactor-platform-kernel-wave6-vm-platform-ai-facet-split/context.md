# Wave Context

## Why This Wave Exists

Wave 5 已完成 platform-first composer uplift，但 runtime 核心状态仍是单体 `AiAgentVm`。

如果不先拆 VM facet，后续：

- `mod-platform-kernel`
- `platform-support`
- shell bridge 去 AI 化

都会继续建立在 AI-shaped VM 上。

## Primary Code Touchpoints

- `cell/packages/core-logic/src/runtime/runtime.ts`
- `cell/packages/core-logic/src/runtime/snapshot/vmSnapshot.ts`
- `cell/packages/organ-logic/src/exec/AiAgentExecutor.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`

## Guardrails

- 不一次性重写全部 `AiAgentVm` 调用方
- 先建立 facet types / accessor / compatibility shell
- 不能通过并行保留两套 VM 真相源规避迁移

## Expected Follow-up

- Wave 7 将在此基础上建立 `mod-platform-kernel` 与真实 `platform-support`
