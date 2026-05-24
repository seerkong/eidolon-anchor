# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由

### 1. 【P0】首批 sink 范围
- 背景：参考项目包含 log、Phoenix、session trace artifact。
- 需要决定：本项目首批实现哪些 sink。
- 选项：
  - A) log sink + session trace artifact sink，Phoenix 预留接口
  - B) log sink + Phoenix sink + session trace artifact sink 一次性实现
  - C) 仅 log sink
- 当前建议：A
- 用户答复：按前三个已归档 Track 的实际设计调整。
- 最终决策：A) 首批实现 log sink + session trace artifact sink，Phoenix 仅预留 sink 接口。
- 决策理由：已归档 protocol frame 与 public RxData 足以支撑 log/artifact；Phoenix 会引入额外外部依赖与配置面，应延后。
- 状态：accepted

### 2. 【P0】extension fact 承载方式
- 背景：当前 `SemanticEvent` 是固定 union。
- 需要决定：extension fact 进入哪里。
- 选项：
  - A) 新增 `semantic_extension_fact` 事件类型，并由 public RxData 暴露
  - B) 独立 observability-only stream，不进入 semantic stream
  - C) 其他（可填写）
- 当前建议：B，首期使用 observability-only stream/fact；后续如需用户展示再扩展 protocol frame
- 用户答复：按前三个已归档 Track 的实际设计调整。
- 最终决策：B) 独立 observability-only fact，不进入 `SemanticEvent` union。
- 决策理由：`SemanticEvent` 与 `SemanticProtocolFrame` 已作为协议事实面归档，强行加入 extension fact 会扩大协议面和测试范围；observability-only fact 更符合 sink 需求且保持用户协议稳定。
- 状态：accepted

### 3. 【P1】trace artifact 根目录
- 背景：需要 session/request scoped artifact，但不同运行模式目录不同。
- 需要决定：根目录来源。
- 选项：
  - A) 从 `outerCtx` 或 runtime config 解析
  - B) 从 effects 注入 writer
  - C) 其他（可填写）
- 当前建议：B，便于隔离文件系统副作用
- 用户答复：按前三个已归档 Track 的实际设计调整。
- 最终决策：B) 通过注入 writer / sink options 提供 artifact 写入能力；可以读取 `outerCtx` 元数据作为默认上下文，但不让 core contract 直接承担文件系统副作用。
- 决策理由：延续 contract/logic/organ 分层，便于测试 sink 失败隔离与不同运行模式。
- 状态：accepted

### 4. 【P0】Observability 数据面位置
- 背景：`add-ai-runtime-rx-protocol-bindings` 已落地 `createSemanticProtocolBinding(vm)` 和 `SemanticProtocolFrame`，但用户确认 observability 不是协议 frame 的衍生层，仍应通过 VM public/private RxData 写入与消费。
- 需要决定：Observability records 应位于哪里。
- 选项：
  - A) 直接从 `vm.eventBus` 派生，不进入 RxData
  - B) 只从 `createSemanticProtocolBinding(vm)` 的 protocol frames 派生
  - C) 在 `AiAgentVmPrivateRxData` / `AiAgentVmPublicRxData` 中新增专属 observability stream；写入 private，消费 public
- 当前建议：C
- 用户答复：observability 也要通过 public rx data 消费，写入也要通过 private rx data，只是有专属 stream；且可观测 stream 不完全是 semantic stream 衍生。
- 最终决策：采用 C
- 决策理由：符合 VM RxData public/private 边界，同时允许 semantic、provider、extension、runtime lifecycle 等多来源统一投递标准 observability record。
- 状态：accepted

### 5. 【P0】Observability signals 归属
- 背景：usage、traceSummary 等 signal 已在常规 public/private RxData 中存在，用户明确指出 usage 不需要专门归类到可观测。
- 需要决定：ObservabilityRxData 是否复制/重分类这些 signals。
- 选项：
  - A) 复制到 ObservabilityRxData 专属 signal 字段
  - B) 不复制；sinks 如需 usage/traceSummary，读取常规 public RxData readonly signals
  - C) 其他（可填写）
- 当前建议：B
- 用户答复：usage 等可观测相关 signals 不需要专门归类到可观测，放到常规 private/public rx data 即可。
- 最终决策：采用 B
- 决策理由：stream 是可观测事实通道，signal 是通用 runtime state；重复归类会造成状态分叉。
- 状态：accepted

### 6. 【P1】messageHistory / RuntimeEffects 迁移范围
- 背景：protocol binding Track 决策保留旧 `messageHistory` 路径作为兼容。
- 需要决定：本 Track 是否迁移 messageHistory 或 RuntimeEffects。
- 选项：
  - A) 不迁移 messageHistory；log sink 可复用 `RuntimeEffects.log` 注入
  - B) 同步迁移 messageHistory 为 observability sink
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：按前三个已归档 Track 的实际设计调整。
- 最终决策：采用 A
- 决策理由：messageHistory 是用户输出/历史副作用，迁移会扩大 blast radius；本 Track 只做并行 observability sink。
- 状态：accepted
