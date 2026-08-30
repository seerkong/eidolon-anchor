# Track：增加 Provider Projection Coverage Gate

Responses canonical replay 在进入 request planner 前必须证明 source materialization 中的全部 tool call/output 已被投影，禁止静默丢失历史事实。
