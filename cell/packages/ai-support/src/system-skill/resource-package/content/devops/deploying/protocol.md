# Deploying protocol

1. The stage context already contains `sys-eidolon-anchor-run` and its `operations/index.md`; do not load them again.
2. Prefer the exact publication receipt entrypoint; resolve only an actually missing identity.
3. For a requested first execution, load resolve-entrypoint, instance-binding, start and agent-execution through one generic `Skill.resources` batch, then call the exact native tools.
4. Preserve the instance and binding receipt. If execution was independently requested, do not return a final response from `deploying`: on the next provider completion call `WorkflowLoadStageContext({ stage: "operating" })`, then use the now-authorized `WorkflowRun` tool with the exact instance receipt. If execution was not requested, return the prepared instance without starting it.

Do not rescan known Types or instances and do not start a run before an instance identity exists.
