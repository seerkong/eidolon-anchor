# 变更：增加 AI runtime 响应式可观测 sinks 与扩展事实

## 背景和动机 (Context And Why)
参考项目将日志、Phoenix 与 trace artifact 从用户协议 pipeline 中解耦，改为消费 public runtime facts 的可观测投影。本项目也应采用同样思想：用户协议输出继续专注 UI/API 语义，可观测系统并行订阅 `ObservabilityRxData`，并通过受控 extension fact 支持工具/扩展贡献运行事实。

前三个已归档 Track 已经改变了本 Track 的前提：VM RxData 与 shared semantic protocol frame 已经落地。可观测应继续遵守 public/private RxData 边界：写入通过 private rx data，消费通过 public rx data。与协议 frame 不同，observability 需要自己的标准 stream，因为它不完全是 semantic stream 的衍生，还会接收 provider capture、extension facts、runtime lifecycle 等其他来源。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 定义 `ObservabilityRxData` 与 sink binding。
- 在 VM private/public RxData 中新增专属 observability stream。
- 定义统一 ObservabilityRecord/Fact 标准，所有来源写入前都必须标准化。
- 实现 log sink 与 session trace artifact sink。
- 保证 sink 失败隔离。
- 新增 observability-only extension fact envelope/helper。
- 设计 provider scene capture hook，使 contract 与 organ/composer 副作用实现分离。

**非目标:**
- 不实现完整 Phoenix exporter 或外部 trace exporter。
- 不实现 replay store 或 trace 查询 UI。
- 不改变用户协议输出语义。
- 不在本 Track 中把 extension fact 强行加入 `SemanticEvent` union。
- 不把 usage 等常规 runtime signals 重复归入 observability 专属 signal。

## 变更内容（What Changes）
- 新增 observability rx projection 与 sink 绑定机制。
- 将关键 runtime semantic/tool/error events 投影为观测 records。
- 将 provider capture、extension facts 等非 semantic 来源写入同一标准 observability stream。
- 新增 session/request scoped trace artifact 写入。
- 新增 extension fact 与 provider scene capture hook contract。

## 影响范围（Impact）
- 受影响的功能规范：AI runtime observability、logging、trace artifact、extension/tool facts、provider request capture。
