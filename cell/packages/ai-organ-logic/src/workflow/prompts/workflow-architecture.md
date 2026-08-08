# Eidolon workflow architecture

Persist canonical XNL workflow resources. Internally choose `AICtrlWorkflow` for durable ordered control, waits, approvals, branches and loops; choose `AIDataWorkflow` for a mutable typed data DAG, graph patches, invalidation and run-local semantic reuse. Mixed requirements may require composition; do not ask an ordinary user to choose the form.

Use only depa-flows canonical roots and resource references. Keep topology and bindings in XNL and implementations in declared TypeScript resources. Preserve the authoring session, proof, publication and fact-recovery contracts.
