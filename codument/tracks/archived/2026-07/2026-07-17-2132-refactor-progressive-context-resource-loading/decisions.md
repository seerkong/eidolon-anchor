# Decisions

## Usage

- Records confirmed implementation decisions for the unified resource-loading model.

### 1. 【P0】Resource fact owner

- Final decision: Extend the existing Conversation/Session context asset model and its LLM Context projection relationships.
- Reason: It already owns workspace/MCP context resources and persists with the conversation; a separate Skill-loaded domain would duplicate truth.
- Status: confirmed

### 2. 【P0】Reuse and reload rule

- Final decision: Reuse only when the same content revision covers the requested fragment and its delivery remains fully visible in materialized provider context. Reload after revision change, removal, or compaction.
- Reason: Persisted observation alone does not mean the model still has the content.
- Status: confirmed

### 3. 【P0】Skill compatibility boundary

- Final decision: Skill remains only as a catalog/name resolver during migration. Its document is loaded through the same local text resource component used by ordinary reads.
- Reason: Later removal of more Skill handling must not require migrating resource state.
- Status: confirmed

### 4. 【P1】Initial source scope

- Final decision: Implement local text files and Skill-resolved local documents first. Defer URL/MCP validators while keeping source contracts extensible.
- Reason: Local files provide deterministic content revisions and cover the observed incident without guessing remote cache semantics.
- Status: confirmed

### 5. 【P0】Excluded control behavior

- Final decision: Do not add generic loop detection, no-progress correction, repeated-call limits, or iteration guards.
- Reason: Resource identity/revision/visibility is the requested root mechanism; generic behavioral correction is a separate concern.
- Status: confirmed
