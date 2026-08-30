# Design: add-provider-projection-coverage-gate

`ResponsesCanonicalReplay` 携带 `ResponsesProjectionCoverageProof`，记录 source 与 emitted call/output ids。compiler 内部 fail-closed；planner 只消费已证明的 items。
