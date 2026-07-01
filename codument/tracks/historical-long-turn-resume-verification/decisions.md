# Decisions

## Usage

- Verification track decisions.

### 1. 【P0】历史验证范围
- 背景：真实历史输入可能需要长时间多轮执行。
- 需要决定：当前 mission 是否要求完整生成最终分析，还是验证暂停/恢复边界。
- 选项：
  - A) 当前 track 验证 pause protocol，完整多轮分析留后续扩展。
  - B) 当前 track 必须跑到完整最终答案。
- 当前建议：A。
- 用户答复：mission 目标要求验证同输入问题；当前实现验证了原失败边界已变成 resumable pause。
- 最终决策：A。
- 决策理由：A 可稳定验证本次架构修复核心，不把非确定性长模型运行作为收口门槛。
- 状态：decided
