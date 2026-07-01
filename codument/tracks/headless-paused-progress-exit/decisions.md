# Decisions

## Usage

- Mission already selected this track as the second implementation slice.

### 1. 【P0】Paused result status name
- 背景：需要把可恢复暂停和硬失败分开。
- 需要决定：状态命名。
- 选项：
  - A) `paused_with_progress`
  - B) `failed_resumable`
- 当前建议：A。
- 用户答复：来自 mission slicing。
- 最终决策：A。
- 决策理由：A 明确表达没有完成但已有可接力进度。
- 状态：decided
