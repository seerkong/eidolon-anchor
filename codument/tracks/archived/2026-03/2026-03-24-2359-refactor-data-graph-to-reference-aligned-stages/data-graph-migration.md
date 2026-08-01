# Migration Strategy

## Phase 0: Freeze the Canonical Spec and the Delivery Rule

1. 先冻结 lexical / syntactic / semantic TypeScript 事件契约
2. 冻结 transcript naming
3. 明确规则：P1 先冻结与验证，随后按 breaking-change 路线直接切主链路

## Phase 1: Contracts and Guardrails

1. 不提前切换历史旧 stream 入口
2. 不提前切换历史旧 terminal 入口
3. 不提前污染正式主链路
4. 先完成新的三层事件定义与 guardrail
5. 新建完整三层事件定义

## Phase 2: Stage Pipeline and Semantic Runtime Cutover

1. 保留 `IngressStreams.timeline` 作为 ingress 顺序来源
2. 建立 lexical / syntactic / semantic stage pipeline
3. 将 runtime bus 收敛到 semantic-first
4. 删除 biz canonical projection 与相关兼容层

## Phase 3: Terminal Projections and Full-Chain Tests

必须新建并打通：

1. lexical fixtures / tests
2. syntactic fixtures / tests
3. semantic fixtures / tests
4. TUI projection fixtures / tests
5. Textual projection fixtures / tests
6. TuiCardGraph / TuiTextGraph fixtures / tests

最低覆盖场景：

1. `default`
2. `chunked-markers`
3. `quote-chunked`
4. `content-unquote`
5. `toolcall-delta`
6. `toolcall-multiple`
7. `toolcall-alt-format`
8. `tui-turn-events`
9. `questionnaire`
10. `plan-approval`
11. `shutdown`
12. `background-result`

这是第一道 gate：

1. 新链路所有 fixtures 和测试全部通过
2. TUI、Textual、card、text 四条消费链都能稳定重放
3. semantic-first runtime 与 terminal 主路径都已可见通过

## Phase 4+: Direct Cutover and Cleanup

在全链路通过后，直接进入 cutover 与清理：

1. 先切换内部测试
2. 再切换 terminal/organ 消费入口
3. 再切换 runtime 主 pipeline
4. 删除旧压缩路径与兼容残骸

收口期间必须做到：

1. 一次只替换一段入口
2. 每替换一段，都重跑新链路测试面
3. 不为旧入口保留兼容代码
