# Complete resource Agent execution

For an admitted resource workflow, an ordinary Ctrl/Data node invokes the typed bound facade:

- `runAgent(input, config)` creates or idempotently reuses the invocation identified by the current node/run/generation; an optional non-empty `config.instanceName` reserves one unique alias inside that run;
- `runTargetedAgent({ byInstanceName }, invocation, config)` addresses that accepted alias;
- `runTargetedAgent({ byInstanceId }, invocation, config)` addresses the exact id returned by an earlier `{ output, instance, receipt }` result.

`invocation` is a closed `{ kind: "ai.agent", payload, metadata? }` object. A selector contains exactly one non-empty `byInstanceName` or `byInstanceId`; never send both and never translate labels or prose into a selector.

Eidolon freezes the exact task tuple, dependency receipt, schemas, effect policy, ordered Material values and payload before creating the generic delegate actor. Resource Agents do not accept a free prompt override.

Input, Message and Material values are validated before provider dispatch. `declared-only` exposes only exact declared Tool resources; `none` exposes no tools. Output is validated before it becomes a parent result or workflow success fact.

Across different invocation keys, calls that target the same accepted instance reuse the same generic runtime-owned actor/session. `profile.ai` stores only the closed instance indexes, pending/completed receipts and opaque generic runtime refs required to address it; conversation, provider and actor state remain in the generic runtime snapshot owner.

Pending continuation, completed repetition and fresh process recovery reuse the frozen instance closure, canonical checkpoint and generic runtime snapshot. They do not re-read a changed package or create a workflow-specific Agent store. They do not depend on child conversation history. If the generic owner is unavailable or the selector/task/semantic facts drift, fail closed instead of silently creating another Agent instance.
