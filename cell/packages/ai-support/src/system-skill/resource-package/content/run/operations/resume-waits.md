# Resume, resolve, or reject an exact wait

Read `WorkflowStatus` for the exact `run_id`. For a persisted manual node or wait handle, call `WorkflowResume` with its explicit node/signal/resume-token facts and typed payload. Use `WorkflowResolve` for the exact success signal or `WorkflowReject` for the exact failure signal.

`Cancelled` is accepted only as the `outcome` of `WorkflowResume` when the existing typed wait-resume protocol declares it. Do not generalize that typed outcome into another runtime transition.
