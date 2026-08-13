# Fix WorkflowFulfill terminal and continuation authority

## Why

A real multi-turn workflow replay still converts child provider failures into empty or partial success results. Each `WorkflowFulfill` invocation also creates a fresh actor from only the current sentence, so a confirmation turn can lose the business plan it confirms.

## Goals

- Make provider failure authoritative regardless of earlier assistant partial content.
- Make `childDone` the only terminal result writer for synchronous delegate tools.
- Project failure through WorkflowFulfill, parent conversation and CLI status without empty/partial success.
- Supply fresh workflow actors with a bounded deterministic projection of prior business conversation.
- Consolidate TUI and all headless/workflow/global commands into the single `eidolon` executable and delete the legacy `eidolon-cli` distribution path.
- Preserve the rule that all stage/scenario/topology semantics belong to the model and global system skill.

## Non-goals

- No keyword, regex, substring or approval-language routing.
- No provider-specific business workaround or silent malformed JSON repair.
- No direct CLI/workspace bypass of the native workflow component.

## Impact

- AI agent cooperative provider terminal handling.
- Orchestrator child completion and conversation tool-result projection.
- WorkflowFulfill child prompt context.
- Headless business journey terminal status and tests.
- Unified terminal entry, build and install surface.
