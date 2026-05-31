# Spec: Replace ApplyPatch Tool

## Overview

The ApplyPatch tool is the project-local patch-first editing surface for AI coding agents. It provides a structured patch DSL, safe hunk matching, staged writes, path/permission governance, structured metadata, freshness/context refresh integration, and prompt guidance.

## Requirements

### Requirement: ApplyPatch shall support the structured patch DSL

The tool SHALL accept a complete patch document with `*** Begin Patch` and `*** End Patch` markers and SHALL support these operations:

- `*** Add File: path`
- `*** Update File: path`
- `*** Delete File: path`
- `*** Move to: new/path` under update operations

#### Scenario: Apply an update patch

- GIVEN an existing text file
- WHEN the caller submits an update patch with one or more hunks
- THEN the tool SHALL update the file according to the patch
- AND return a successful structured result.

#### Scenario: Reject malformed patch envelope

- GIVEN a patch missing the begin or end marker
- WHEN the caller invokes ApplyPatch
- THEN the tool SHALL fail without mutating files
- AND return a diagnostic explaining the malformed patch.

### Requirement: Update hunks shall support real named anchors

The tool SHALL parse `@@` hunk headers as anchors. A hunk MAY contain one or more consecutive `@@ ...` anchor lines before its body. Non-empty anchor text SHALL be used to locate the hunk’s search region in order.

#### Scenario: Use a function anchor

- GIVEN a file containing multiple similar blocks
- WHEN a patch hunk starts with `@@ functionName` or another meaningful anchor
- THEN the tool SHALL search for the anchor before applying the hunk
- AND SHALL avoid applying the hunk to an unrelated earlier block.

#### Scenario: Multiple anchors narrow the search region

- GIVEN a file containing nested or repeated sections
- WHEN a hunk contains multiple consecutive anchors
- THEN the tool SHALL resolve the anchors in order
- AND use the final resolved anchor position as the preferred application region.

### Requirement: Hunk matching shall be safe and resilient

The tool SHALL attempt hunk matching in a controlled order:

1. exact line sequence matching
2. anchored exact matching when anchors are present
3. normalized matching that ignores trailing whitespace differences
4. fuzzy whitespace-collapsed matching

If normalized or fuzzy matching finds multiple candidate locations, the tool SHALL fail closed instead of guessing.

#### Scenario: Match despite trailing whitespace drift

- GIVEN a target file whose only difference from the patch old lines is trailing whitespace
- WHEN the patch is applied
- THEN the tool MAY apply the patch using normalized matching
- AND the result SHALL report the match mode used.

#### Scenario: Reject ambiguous fuzzy match

- GIVEN a patch hunk whose normalized or fuzzy old lines match multiple locations
- WHEN the patch is applied
- THEN the tool SHALL fail without mutating files
- AND report that the hunk matched multiple candidate locations.

### Requirement: File writes shall be staged and guarded

The tool SHALL validate all operations before committing filesystem changes where practical. It SHALL guard against unsafe file operations:

- Add file SHALL fail if the target file already exists.
- Delete file SHALL fail if the target is missing or a directory.
- Update file SHALL fail if the source is missing or a directory.
- Move SHALL fail if the destination already exists.
- A single patch SHALL fail if it touches the same resolved path multiple times.

#### Scenario: Add existing file is rejected

- GIVEN an existing file path
- WHEN a patch declares `*** Add File:` for that path
- THEN the tool SHALL fail without overwriting the file.

#### Scenario: Move onto existing file is rejected

- GIVEN a move destination that already exists
- WHEN a patch attempts to move another file to that destination
- THEN the tool SHALL fail without overwriting the destination.

### Requirement: Path resolution and permissions shall follow this project’s governance

The implementation SHALL preserve this project’s accepted path semantics and local permission flow. Relative paths, absolute paths, home-relative paths, and traversal-like inputs SHALL be resolved by existing path helpers and SHALL go through existing permission/workspace access gates before mutation.

#### Scenario: Permission denied blocks mutation

- GIVEN a patch that touches a path outside the currently authorized scope
- WHEN permission is denied
- THEN the tool SHALL return the permission error
- AND SHALL NOT mutate any touched path.

### Requirement: Output shall preserve diff compatibility and add structured metadata

On success, the tool SHALL keep the current unified diff output compatibility and SHALL add structured metadata where applicable:

- `ok`
- `touched_files`
- `touched_files_absolute`
- `added_count`
- `updated_count`
- `deleted_count`
- `moved_count`
- `match_modes_used`
- `context_refresh_hint` when files changed
- any invalidated read-cache entries if the project supports such tracking

On failure, the tool SHALL return structured error data with actionable diagnostics.

#### Scenario: Successful update returns diff and metadata

- GIVEN a valid update patch
- WHEN the patch is applied
- THEN the output SHALL include a unified diff
- AND SHALL include touched files, counts, and match modes used.

### Requirement: Failure diagnostics shall guide recovery

When hunk application fails, the tool SHALL report enough information for an agent to recover:

- hunk label / anchor label
- expected old snippet summary
- nearest current line when available
- reason for failure
- retry hint recommending fresh read and smaller/named-anchor hunks

#### Scenario: Stale hunk fails with useful detail

- GIVEN a hunk based on stale file content
- WHEN the old snippet no longer matches
- THEN the tool SHALL fail without mutation
- AND the error SHALL include expected snippet and nearest current line if available.

### Requirement: ApplyPatch shall integrate with freshness/context refresh when available

The tool SHALL check available read freshness/cache mechanisms before writing and SHALL invalidate affected file context after writing. If the project does not already provide a compatible read cache, the implementation SHALL provide the smallest project-appropriate adapter or explicitly document the boundary while still returning a context refresh hint for touched files.

#### Scenario: Earlier read context becomes stale after patch

- GIVEN files changed by ApplyPatch
- WHEN the tool returns success
- THEN the output SHALL tell the agent that earlier read context for touched files is stale
- AND future patches should be based on a fresh read.

### Requirement: Prompt/tool descriptions shall instruct patch-first editing

The ApplyPatch tool detail and relevant coding-agent prompt guidance SHALL instruct agents to prefer ApplyPatch for normal text edits, use small hunks, prefer named anchors, reread after failures, and avoid shell-simulated editing for ordinary text changes.

#### Scenario: Tool detail documents named anchor usage

- WHEN an agent sees the ApplyPatch tool detail
- THEN it SHALL see examples or guidance for `@@ def foo` / `@@ class Bar` style anchors
- AND fallback guidance after failed patch attempts.
