# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由

### 1. 【P0】首个协议绑定目标
- 背景：项目可能有 TUI、terminal、web/composer、OpenAI-compatible 多个入口。
- 需要决定：首个可验证入口。
- 选项：
  - A) 先绑定 terminal/TUI 输出，风险最小
  - B) 先绑定 web/composer 输出，产品价值更直接
  - C) 先绑定 OpenAI-compatible stream，便于与参考项目对齐
- 当前建议：A 或 B，按当前最活跃入口选择
- 用户答复：按已归档 VM runtime shape 与 RxData 数据面落地结果跟进调整。
- 最终决策：先落地不绑定具体 UI route 的 semantic protocol frame binding，位置靠近 `ai-organ-logic/src/stream`；TUI、web/composer、OpenAI-compatible 后续都从该 frame 层消费。
- 决策理由：当前代码已经有 `AiAgentVmPublicRxData.semanticEvents`、domain streams、usage 与 traceSummary readonly signals；先做 shared semantic frame 可以最大化复用已落地 public 数据面，避免过早被某个 UI/HTTP route 的历史输出路径牵引。
- 状态：decided

### 2. 【P1】messageHistory 副作用迁移策略
- 背景：现有 `RuntimeEffects.messageHistory` 仍记录输出副作用。
- 需要决定：本 Track 是否迁移。
- 选项：
  - A) 仅并行新增协议 RxData，不迁移 messageHistory
  - B) 同步迁移 messageHistory 为 RxData consumer
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：按已归档 VM runtime shape 与 RxData 数据面落地结果跟进调整。
- 最终决策：A) 本 Track 仅并行新增协议 RxData / semantic protocol frame binding，不迁移 messageHistory。
- 决策理由：`bindVmDomainRxStreams` 已证明 conversation domain streams 可以通过 public RxData 暴露；messageHistory 仍是现有副作用路径，迁移它会扩大 blast radius，应留给后续专门 track 或具体 adapter 迁移。
- 状态：decided
