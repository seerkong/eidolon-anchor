# Design: embed-eidolon-builtin-vfs-and-coding-agent

## 1. Authority and ownership

```text
@cell/mod-ai-coding authoring tree
  resources/builtin-eidolon/.eidolon/**
       │ deterministic generator
       ▼
GeneratedBuiltinEidolonVfsSnapshot.xnl
       │
       ├── source transport: versioned generated asset
       └── compiled transport: BunFS embedded Blob
                    │
                    ▼
          one BuiltinEidolonVfsSource
                    │ deserializeVfsSnapshot
                    ▼
          immutable Builtin base tree + read port
```

`@cell/mod-ai-coding` owns resource content. The generator owns only deterministic projection. BunFS owns only byte transport. The Builtin base is an input to G4 materialization and is not itself the current Effective VFS authority.

## 2. Mapping from mature Eidolon prompt logic

The new AIAgentDefinition is a Halfcode restructuring of the mature path, not a new prompt implementation:

| Mature source / behavior | Halfcode resource |
|---|---|
| `mod-ai-kernel/src/prompt/KernelWorkLoop.md` + `KernelRules.md` | stable Kernel `Prompt` |
| `mod-ai-coding/src/agent/primary/{AGENT,IDENTITY,ROUTING}.md` + coding/delegation modules | stable Coding `Prompt` |
| workspace `AGENTS.md` discovery/assembly | `AgentMessageSource` implementation `eidolon.workspace-agents/v1` |
| mature history anchor/context splice and provider conversion chain | `AgentContextPipeline` implementation `eidolon.standard-context-pipeline/v1` |
| exact execution tools | ordered `ToolRef` children |
| fixed provider prefix | ordered `MessagePrefix` children |

The resource FQN is `eidolon.coding.CodeAgent`; `builtin` is transport provenance and MUST NOT enter semantic identity.

## 3. Authoring tree and snapshot

The source tree is a complete ResourcePackage rooted at `/.eidolon/resources`. It contains its own registered catalogs and all resources required to resolve `eidolon.coding.CodeAgent`. The generator:

1. walks the authoring tree with symlinks and unsupported entries rejected;
2. normalizes logical paths under `/.eidolon`;
3. derives directory/file node ids as a stable digest of kind + logical path;
4. assigns file type from extension and preserves exact UTF-8 bytes;
5. serializes a full `VfsSnapshot` through `xnl-vfs`;
6. re-runs in `--check` mode and fails if the committed snapshot differs.

The snapshot revision and tree/content digests are computed from canonical serialized bytes. Startup never calls random id generation.

## 4. Source and BunFS transport

Runtime exposes a small `BuiltinEidolonVfsAssetPort` returning snapshot bytes. The source adapter reads the generated asset next to package sources. The compiled adapter selects exactly one Bun embedded Blob under a reserved `eidolon-builtin/` prefix. Both feed the same parser, validators, immutable VFS object and read-port adapter.

The final TUI build follows the proven Halfcode CLI pattern: enumerate the required generated asset, inject `import ... with { type: "file" }` at the Bun compile boundary, and use stable asset naming. Missing/duplicate embedded assets fail closed. Development mode does not emulate BunFS by reading `.eidolon`; it reads the same generated snapshot asset.

## 5. Halfcode proof

The Builtin VFS read port is adapted to Halfcode's storage-neutral `ResourcePackageReadPort`. Loading root `/.eidolon/resources` must produce the same records, provenance and content identities in source and compiled probes. This is verification and a reusable boundary for G5, but the App registry does not switch authority in this Track.

## 6. Testkit migration

`testkit/codument-proposition` retains test-specific App/Workflow definitions and may add an invocation-specific instruction resource, but it MUST reference `resource://eidolon.coding.CodeAgent` and MUST NOT recreate the formal MessagePrefix, ContextPipeline, Kernel/Coding prompts or ToolRefs. Tests verify the formal resource is present independently of the proposition workspace.

## 7. Failure boundaries

- authoring tree symlink, path escape, duplicate logical path, invalid UTF-8 or nondeterministic generation: build fails;
- missing/duplicate BunFS snapshot asset: compiled runtime fails before resource consumption;
- snapshot parse, node identity, digest or Halfcode closure mismatch: no Builtin base proof is produced;
- physical workspace `.eidolon` absence is normal and must not trigger prompt downgrade or generated fallback.

## 8. Verification

- deterministic generator tests plus `generate --check`;
- source loader snapshot/read-port tests;
- Halfcode resource closure tests for the mature Agent and dependencies;
- a tiny compiled Bun probe validates BunFS bytes and reports the same proof as source mode;
- proposition support tests verify no copied production resources remain;
- targeted `mod-ai-coding`, symbiont, terminal build-script and typecheck suites.
