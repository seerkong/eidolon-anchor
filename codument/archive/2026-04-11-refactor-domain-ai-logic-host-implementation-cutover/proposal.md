# 变更：推进 domain-ai-logic 成为第一批真实实现宿主

## 背景和动机

`@cell/domain-ai-logic` 已经具备显式宿主地位，shell/runtime 也已经开始正式消费它。

但当前它仍主要停留在 re-export 收口层。如果不继续推进，这个宿主会长期停留在“入口已成立，但历史包仍是事实真相源”的中间态。

## 要做

- 让 `domain-ai-logic` 承接第一批 host-facing AI runtime glue 实现
- 优先处理 shell runtime facade、runtime coordinator glue、host-facing orchestration bridge
- 建立 focused tests，证明 `domain-ai-logic` 不再只是 forwarding shell

## 不做

- 本次不创建 `platform-logic`
- 本次不把 actor/runtime primitive 本体机械搬进 `domain-ai-logic`
- 本次不做大爆炸式全仓 rename 或全量物理迁移

## 影响范围

- `cell/packages/domain-ai-logic`
- `cell/packages/organ-logic`
- `terminal/packages/organ`
- focused ownership tests
