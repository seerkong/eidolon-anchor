## 上下文
可观测不应嵌入用户协议 adapter，也不应让 sink 直接读取 private runtime。它应该遵守 VM RxData 的 public/private 边界：可观测事实由受控 helper/bridge 写入 private observability stream，sinks 从 public observability stream 消费，并和 TUI/Web/OpenAI 等用户协议并行消费事实面。

前三个已归档 Track 已经提供了稳定前提：
- `AiAgentVm` 纯契约位于 `ai-core-contract`，具体实现位于 `ai-core-logic` / organ 层。
- `ensureVmRxData(vm)` 提供 public readonly facts：semantic/domain streams、usage、traceSummary。
- `createSemanticProtocolBinding(vm)` 在 organ stream 层从 public facts 派生 `SemanticProtocolFrame`，这是用户协议投影层，不应成为 observability 的唯一来源或写入主路径。

因此 Observability 应新增专属标准 stream：semantic/domain/protocol frame 可以作为输入来源之一被桥接为 observability record，但 provider capture、extension facts、runtime lifecycle 等也能通过同一标准写入。

## 方案概览
1. Observability projection
  - VM RxData 新增 `observabilityRecords` / `observabilityErrors` 或等价标准 stream。
  - private rx data 暴露可写 observability stream；public rx data 暴露只读 observability stream。
  - `ObservabilityRxData` 是 public observability stream 的场景消费视图，可附带读取 normal public `usage` / `traceSummary` signals，但不重新定义这些 signals。
  - semantic/domain/protocol frame、provider capture、extension facts、runtime lifecycle 都通过标准 mapper/helper 写入 private observability stream。
2. Sink binding
  - `LogObservabilitySink`：结构化日志。
  - `SessionTraceArtifactSink`：按 session/request 写 timeline artifact。
  - `PhoenixObservabilitySink`：预留或可选实现。
3. Extension facts
  - contract 定义 observability record / extension fact envelope。
  - organ/logic 提供受控 helper。
  - 扩展只传 payload/source/fact name/phase，不拿 private writer。
  - 首期不修改 `SemanticEvent` union；如需用户可见展示，后续通过 protocol frame 扩展完成。
4. Provider scene capture
  - contract 定义 hook。
  - provider runtime 调用可选 hook。
  - organ/composer 注入实际副作用实现。

## 影响范围与修改点（Impact）
- 受影响的文件/模块：`ai-core-contract` RxData/observability fact/provider hook 纯类型、`ai-core-logic/runtime/rxData.ts` 的 private/public RxData 实现、`ai-organ-contract` observability record/sink 纯类型、`ai-organ-logic/src/observability` projection/sinks、organ/composer runtime factory、logging/trace artifact support。
- 应修改 `AiAgentVmPublicRxData` / `AiAgentVmPrivateRxData` 主 shape，新增 observability stream；不应修改 `SemanticProtocolFrame` 主 shape，除非后续用户协议展示 extension fact。

## 决策摘要
- 详见 `decisions.md`
- 当前关键结论：建议先实现 log + artifact sinks；extension fact 首期为 observability-only 并写入 private observability stream；usage 等 signals 保持常规 public/private RxData；文件副作用通过注入 writer 隔离。

## 风险 / 权衡
- extension fact 进入 semantic union 会扩大协议面 → 首期不进入 semantic union，使用 observability-only envelope；需要用户展示时再扩展 protocol frame。
- artifact 写入可能失败 → sink 内捕获并隔离。
- provider hook 可能造成层间依赖 → contract-only hook，外层注入实现。

## 迁移计划
1. 扩展 VM RxData contract，新增标准 observability stream。
2. 定义 observability records、extension fact envelope 与 sink protocol。
3. 在 private rx data 中实现可写 observability stream，并在 public rx data 中暴露只读 stream。
4. 实现 semantic/domain/provider/extension/runtime 来源到 observability records 的标准 mapper/helper。
5. 实现 log sink 与 artifact sink。
6. 增加 provider scene capture hook contract 与一个注入示例。

## 待解决问题
- Phoenix 后续是否纳入首批之外的实现。
- extension fact 后续是否需要进入用户协议展示层。
