# Historical Long-Turn Resume Verification Design

## 上下文

本 track 是 mission 最后一段验证，目标是用真实输入确认前两段实现没有停留在单元测试层。

## 方案概览

1. Run source CLI with the same Sparrow session analysis input.
2. Use short timeout to trigger long-turn pause deterministically.
3. Inspect trace and last-message file.
4. Record evidence in track/mission reports.

## 决策摘要

- Use source CLI, not dist CLI, so current workspace changes are exercised.
- Treat `paused_with_progress` smoke as pass for pause protocol.
- Leave full multi-cycle resume completion as future extended validation if needed.

## 风险 / 权衡

- Short timeout validates pause projection but not final answer quality.
- External model/tool behavior can make full historical replay slow and non-deterministic.
