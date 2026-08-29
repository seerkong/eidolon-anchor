# Resource-manage Eidolon's complete Agent definition pipeline

## Why

Workflow `AIAgentDefinition` currently supplies a small prompt and exact tools, while an ordinary Eidolon coding actor receives a mature profile-assembled prefix and always passes through the Conversation Domain context materialization chain. Treating the Workflow Agent as a separate, simpler runtime loses established instructions and obscures where dynamic context is inserted.

This Track converts that existing design into its first Halfcode-managed form. It does not create another Agent executor or context state machine. `MessagePrefix` compiles ordered static and dynamic message sources; `ContextPipeline` freezes a code resource that selects the canonical Eidolon pipeline. Conversation, provider epoch, compaction, persistence, tool admission and provider conversion retain their current owners.

## Outcomes

- The design contains an exhaustive legacy-to-Halfcode ledger with evidence, authority, mapping, disposition and parity checks.
- `MessagePrefix` supports ordered `Message` and `MessageSource` splicing; the first dynamic source loads workspace `AGENTS.md` and may emit zero or one system message.
- `ContextPipeline` is a frozen code-backed resource. Its code declares the canonical stages and is validated before the existing runtime authority executes them.
- The Codument Workflow `CodeAgent` receives copies of the mature kernel/coding prefix plus workspace instructions and declares the standard context pipeline.
- Legacy `<Messages>` Agents remain compatible. Resource Agents still use `DelegateActor`, the Conversation Domain, provider admission/conversion and exact tool admission.
- Parity tests cover stable prefix order, backward history-anchor insertion, WorkContext placement, compaction, provider epoch/handoff, recovery and tool surface.

## Non-goals

- Replacing the Conversation Domain or moving its durable transitions into a resource script.
- Inventing a second provider/session/recovery/cache implementation for Workflow Agents.
- Making the first `ContextPipeline` language broadly declarative or evaluating arbitrary untrusted JavaScript.
- Migrating every built-in non-Workflow Agent in this Track; this is the Workflow trial that establishes the compatible cutover path.
