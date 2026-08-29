# Track: preserve-failed-workflow-public-evidence

## Why

The official DeepSeek `modeling-blog / ai_ctrl` live cell reached its second
workflow actor and then failed with `402 Insufficient Balance`. The durable
workflow log correctly retained `workflow.effect.requested` and
`workflow.effect.failed`, but the headless public projection exposed zero
workflow executions because node evidence was recorded only after the child
actor returned successfully. The proposition harness therefore misclassified a
known AICtrlWorkflow provider failure as missing mode identity.

## Goals

- Publish workflow run/node identity as soon as the child actor is admitted.
- Preserve the identity when the admitted child later fails or is interrupted.
- Keep completion/failure authority separate; identity evidence must not imply
  success.
- Cover both AICtrlWorkflow and AIDataWorkflow with focused offline regression
  tests, then rebuild and install the exact verified Eidolon executable.

## Non-goals

- Do not classify `402 Insufficient Balance` as retryable or hide it.
- Do not fabricate node evidence before actor admission succeeds.
- Do not change provider prompts, cache epochs, retry budgets, or workflow
  success semantics.
