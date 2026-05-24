# Wave Context

## Why This Wave Exists

当前 shell adoption 已经不再自己拼默认产品语义，但：

- `TerminalRuntime` 仍直接知道 AI runtime internals
- `terminal/core` 仍硬编码 AI slash truth

Wave 8 的任务是把这些“还残留在 shell 层的 AI ownership”进一步收回到 AI 领域内核。

## Primary Code Touchpoints

- `terminal/packages/core/src/AIAgent/SlashCommands.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- `cell/packages/mod-ai-kernel/src/index.ts`

## Guardrails

- 不把 shell bridge 再变成第二套默认产品语义真相源
- slash grammar/help/prompt expansion 必须一起看，不能只改 parser

## Expected Follow-up

- Wave 9 将进一步把 AI contract/logic 从历史 `core-*` / `organ-*` 边界显式域化
