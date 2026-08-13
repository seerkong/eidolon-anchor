# Planning protocol

1. 读取用户目标与现有 workspace 事实。
2. 给出 goal、inputs、outputs、actors、constraints、failure policy 和 acceptance。
3. 选择下一 stage；需要生成或修改 DSL 时选择 `coding`。
4. 返回结构化 decision，禁止从文本表面词汇直接产生 route。

允许工具：只读 catalog/workspace/status 与问题工具。禁止 publish、deploy、run。

若当前 invocation 已是 goal/input/output/failure policy 完整的 confirmed fresh create，说明不需要 planning：立即 transition 到 `coding`，不得调用 catalog/list/summary。不要用“先了解现状”制造 discovery 轮次。
