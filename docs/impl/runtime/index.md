---
knowledge_system: impl
knowledge_plane: runtime
doc_role: guide
status: active
last_verified: 2026-06-01
---

# Runtime Implementation Knowledge

## Boundary

This implementation plane owns runtime execution, actor/fiber scheduling, persistence recovery, and runtime data-plane knowledge.

## Not Owned Here

- User-facing terminal layout belongs with terminal UI implementation knowledge.
- Domain ontology belongs in `docs/modeling/`.

| Category | Purpose | When to Read |
|----------|---------|--------------|
| overview | Mental models and architecture | Need orientation for runtime control flow |
| howto | Repeatable operations | Need to change or maintain runtime behavior |
| rules | Constraints and conventions | Need to avoid runtime invariants violations |
| examples | Worked examples | Need a concrete reference |
| reference | Maps and stable references | Need lookup data |
| troubleshooting | Failures and diagnosis | Need to debug runtime sessions |
