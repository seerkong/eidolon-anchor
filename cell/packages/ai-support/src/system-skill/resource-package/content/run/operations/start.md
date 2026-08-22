# Start a prepared instance

Require an exact `instance_id` and independent execution authorization. Call `WorkflowRun` with `confirmed: true` only when that authorization is present; omit confirmation to obtain the declared no-effect preview. Preserve the returned `run_id`, terminal flag, output, and error as runtime facts.

If no instance identity exists, return to the explicit deploying stage and create one. Do not infer execution authorization from authoring proof, publication, or the person's earlier unrelated statements.
