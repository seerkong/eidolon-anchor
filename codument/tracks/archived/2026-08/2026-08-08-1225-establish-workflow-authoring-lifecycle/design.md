# Design

## 设计原则

1. 完整 authoring lifecycle 是产品基线；现有 Eidolon 实现提供可复用基础设施。
2. 格式和宿主边界必须显式，不得削弱 authoring lifecycle。
3. AI author actor 不是文件 authority；WorkflowComponent 是 session、proof 和 publication transition 的唯一 authority。
4. 对话、TUI 和 CLI 共享相同的 native component/tool contract。

## Requirement coverage mapping

| Product capability | Eidolon implementation |
| --- | --- |
| definition/run stage skill context | versioned workflow skill assets + `WorkflowGetAuthoringContext` query/tool |
| ListAuthoringTemplates | installed XNL workflow template catalog |
| ListPrebuiltWorkflows / reusable agents | installed XNL workflow and agent resource briefs |
| InitEmpty/ByTemplate/ByPrebuilt/FromSource | authoring session open operations |
| `/base`, `/refs`, `/work`, `/out` VFS | containment-safe `WorkflowAuthoringSessionStore` over injected root |
| AuthoringWorkspace operations | one `WorkflowWorkspace` native tool with session-scoped operations |
| ValidateWorkspace / DryRunWorkspace | depa-flows loaders and static projections over `/work` |
| validation revision | content-addressed session proof fact invalidated by every mutation |
| PublishWorkspace confirmed gate | component-owned atomic publish transition with explicit authorization |
| ListSessionFlows / summary | authoring session query and compact recovery facts |
| resource package | XNL bundle through depa-flows loaders |
| public tool transport | Eidolon native standardized tools and CLI projection |

## Session model

```text
WorkflowAuthoringSession
  identity: sessionId, operation, target
  mounts:
    /base  read-only source snapshot
    /refs  read-only controlled references
    /work  editable package
    /out   generated authoring evidence
  facts:
    status
    currentRevision
    validationRevision?
    validationResult?
    dryRunResult?
    audit sequence
```

Every mutation invalidates `validationRevision`. Publication requires:

- current diff evidence;
- zero-diagnostic validation;
- successful static dry-run for the same revision;
- explicit publication authorization;
- an explicit target identity/scope;
- atomic write and loader readback.

Publication never implies execution.

## High-level authoring route

```text
ordinary-language request
  -> load definition-stage workflow context
  -> separate authoring clauses from exact business payload
  -> decide whether durable workflow is warranted
  -> select installed template/prebuilt starting fact
  -> open recoverable authoring session
  -> edit only /work through WorkflowWorkspace
  -> diff -> validate -> dry-run -> repair
  -> present business summary and publication evidence
  -> await/consume explicit publication authorization
  -> component publish
```

The author actor may choose XNL nodes, ports and adapters internally, but the ordinary user surface does not require or report those details by default.

## Compatibility and architecture

- Existing `WorkflowCreateBundle` is limited to creating a session-backed draft and `WorkflowPatchBundle` is plan-only. Neither compatibility surface can publish or mutate a published definition; all writes and publication flow through session operations.
- Existing Node filesystem authoring store is reused for containment and atomic writes, then extended with session mounts, audit and metadata rather than replaced by a second store.
- Runtime Material effects receive a narrowed `materials/**` capability, never the authoring store or session namespace.
- depa-flows remains the only parser/lowering/runtime semantic authority.
- No XML parser, alternate workflow root or MCP transport is added.

## Verification

- Cover mixed authoring request, invalid-repair, publication gate, fact recovery, template selection and VFS denial scenarios.
- Assert exact business payload preservation.
- Assert edits stale validation and stale proofs cannot publish.
- Assert publication does not create or start a run.
- Assert Material effects cannot read or write `.authoring/**` or published definition paths.
- Assert TUI/headless CLI runtime bindings reach the same session store and tool schemas.
