# 变更：实施平台微内核 Wave 8 的 shell bridge and AI slash decoupling

## 背景和动机

当前 shell/runtime entry 已不再自己定义默认产品语义，但仍直接知道大量 AI runtime 细节；同时 AI slash/direct-action contract 仍硬编码在 `terminal/core`。

这说明 shell 还不是平台无关 bridge，AI 领域 contract 也还没有回到领域层。

## 要做

- 让 shell/runtime entry 更接近 platform-neutral bridge
- 将 AI slash/direct-action contract 下沉到 AI domain kernel
- 收紧 terminal/core 对 AI 语义的直接 ownership

## 不做

- 本次不做完整 VM facet split
- 本次不处理 domain-ai-contract/logic 全量域化

## 影响范围

- `terminal/packages/core/src/AIAgent/SlashCommands.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- `cell/packages/mod-ai-kernel`
- 相关 focused tests
