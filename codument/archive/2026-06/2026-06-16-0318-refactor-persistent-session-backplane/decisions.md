# Decisions

## Usage
- 记录需用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母仅用于选项
- 后续执行中出现的新决策继续追加本文件

### 1. 【P0】重构深度
- 背景：persistence/recovery 当前与 executor 逻辑（ai-organ-logic）耦合，存在 5 项软耦合（见 analysis/findings.md）。
- 选项：
  - A) 完整拆包 + 单向端口
  - B) 原地 port 化（不新建包）
  - C) 最小（仅契约 + 1-2 项最高风险）
- 用户答复：A（2026-06-15）
- 最终决策：A — 把 persistence/recovery 从 ai-organ-logic 抽出为专用 data/persistence 包，建 live→write port（write-behind，非阻塞）+ recovery→read port（每事实单一来源）单向契约；5 项残留耦合全部硬化。
- 决策理由：与 mission backplane 愿景一致；一次把存储侧事实边界做硬，避免后续 W3/W4 反复触碰同一脆弱面。
- 状态：accepted

### 2. 【P0】真实事故 replay harness 归属
- 背景：005 真实 TUI 事故（"重复读文件"）的端到端 recovery replay 验证，mission 把它排在 backplane 或 W4 complete-migration。
- 选项：
  - A) 本 track 内建
  - B) 推到 W4 收口 track
- 用户答复：A（2026-06-15）
- 最终决策：A — 在本 track 建 005 事故的 recovery replay harness（恢复后不再重复读、配对历史完整）。
- 决策理由：本 track 正好重构 recovery 路径，是验证"根因修复后真实会话不再失败"的最自然位置；也兑现 lifecycle track 偏差 #3 标注的下游验证。
- 状态：accepted

### 3. 【P1】Surface 读取加载器（残留耦合 #5）
- 背景：TUI hydration 自建 repository（只读），与 isolate-runtime-projection-surfaces / G-surface-readonly 重叠。
- 选项：
  - A) 推给 surfaces track（本 track 只提供 projection-read port 能力）
  - B) 本 track 一并改 TUI 接线
- 用户答复：A（2026-06-15）
- 最终决策：A — 本 track 提供 projection-read port 能力并声明边界，实际 TUI 读取器改接留给 isolate-runtime-projection-surfaces，避免两 track 边界模糊与冲突。
- 决策理由：surface 隔离是另一条线的专责（G-surface-readonly）；本 track 聚焦持久化/恢复后端。
- 状态：accepted
