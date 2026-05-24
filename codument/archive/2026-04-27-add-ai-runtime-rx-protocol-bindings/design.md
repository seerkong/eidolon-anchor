## 上下文
Core public RxData 是 runtime fact 的只读面；协议 RxData 是对用户输出协议的投影。该层属于外层 AI 领域微内核与 shell/composer 边界，不应污染内层平台微内核。

前两个已归档 Track 已经改变了本 Track 的前提：
- `AiAgentVm`、runtime ctx、snapshot、registry data 与 rx seam 已迁入 `ai-core-contract`，`ai-core-logic` 只负责实现逻辑。
- `ensureVmRxData(vm)` 已在 `ai-core-logic/src/runtime/rxData.ts` 落地，当前 public 面包含 `semanticEvents`、`historyDomainStream`、`promptDomainStream`、`sessionDomainStream`、`usage`、`traceSummary`。
- organ 层可用 `bindVmDomainRxStreams` 把 conversation domain runtime 接到 public/domain stream，但 core 不依赖 organ。

因此本 Track 不再定义 VM rx data 主 shape，也不再直接围绕 `eventBus` 或 private writers 做协议输出；它只负责从已存在的 public readonly 数据面派生 protocol frame / protocol rx binding。

## 方案概览
1. 协议 frame / RxData 基础模式
  - 输入：`ensureVmRxData(vm).publicRxData`。
  - 输出：不绑定具体 UI 的 semantic protocol frame stream，以及 usage/trace summary readonly signal projection。
  - frame 保留 trace、actor、team、event type、payload 与 source stream，后续 TUI/web/OpenAI-compatible adapter 再做格式化。
2. 首个绑定目标
  - 首个目标固定为 `ai-organ-logic/src/stream` 附近的 semantic protocol frame binding，而不是直接改一个具体 UI route。
  - 这样可以复用当前 `SemanticEvent` 类型与已落地的 VM public RxData，同时给 terminal/web/OpenAI-compatible 留出共同输入层。
3. 绑定时序
  - factory 接收 `AiAgentVm`，先调用 `ensureVmRxData(vm)` 初始化数据面。
  - factory 只消费返回结果中的 `publicRxData`，不得读写 `privateRxData`。
  - binding 必须在 actor submit/execute 前创建，并负责 dispose。
4. 渐进迁移
  - 本 Track 先新增 shared semantic protocol binding 和 focused tests。
  - 保留旧 OutputStream/messageHistory/RuntimeEffects 路径作为兼容，避免大爆炸迁移。

## 影响范围与修改点（Impact）
- 受影响的文件/模块：`ai-organ-contract` 的 protocol frame 纯类型、`ai-organ-logic/src/stream` 的 protocol binding、`ai-core-logic/runtime/rxData.ts` 的 public shape 消费点、AI runtime submit/execute 周边测试。
- 不应修改 `ai-core-contract/src/runtime/AiAgentVm.ts` 的 VM RxData 主 shape，除非 gap-loop 发现 public 面缺少无法从协议层派生的事实。

## 决策摘要
- 详见 `decisions.md`
- 当前关键结论：首个绑定目标固定为 semantic protocol frame binding；暂不迁移全部 messageHistory 副作用。

## 风险 / 权衡
- 绑定过晚会丢 hot stream 事件 → 增加时序测试。
- 一次性迁移所有协议风险大 → 渐进迁移。
- 协议层若拿到 private writers 会破坏 data/logic 分离 → factory/type test 只暴露 public read side。
- 如果首个目标直接选 TUI/web/OpenAI route，容易被路由细节牵引 → 先做 shared semantic frame，再由具体 adapter 消费。

## 迁移计划
1. 在 contract 层定义 protocol frame 与 binding 接口。
2. 为 semantic protocol binding 编写测试：绑定先于执行、public-only、dispose 幂等。
3. 实现 `AiAgentVmPublicRxData` 到 semantic protocol frame stream 的转换。
4. 投影 `usage` 与 `traceSummary` readonly signal，不向 semantic stream 写 synthetic event。
5. 验证输出与旧路径兼容，保留旧 OutputStream/messageHistory 路径。

## 待解决问题
- 长期是否废弃部分 RuntimeEffects 输出副作用。
- 具体 TUI/web/OpenAI-compatible adapter 的迁移顺序。
