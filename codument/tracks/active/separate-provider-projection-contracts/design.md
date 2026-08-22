# Design: separate-provider-projection-contracts

- `OpenAIChatHelpers` 只拥有 Chat wire projection/repair。
- `ResponsesCanonicalReplayCompiler` 只拥有 Responses canonical/native replay compilation。
- `ResponsesRequestPlan` 只消费 compiler 结果和 checkpoint optimization facts。
- source conformance test 禁止 Responses replay owner import Chat helper。
