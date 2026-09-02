# Decisions

## Usage
- 记录需用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母仅用于选项
- 后续执行中出现的新决策继续追加本文件

> 本 track 创建时用户授权：「如果 W4 收口 track 没有待确认项，创建后可直接 codument-implement」。scoping audit 确认决策点 clear-cut（mission 非目标已预决风险问题），下列两项为「构建深度」选择、均有安全默认，**非阻塞**——由编排器按 audit 推荐 + 隐私安全取默认，记录如下；若用户不同意可在实现期推翻。

### 1. 【P1】真实事故 conformance resource 形态
- 背景：deliverable 要「真实事故 session conformance resource」。真实 old-format session 在磁盘存在但 `.eidolon` gitignored 且含潜在敏感内容。
- 选项：
  - A) 忠实最小化/脱敏 incident fixture（不含原始真实 session 数据）
  - B) 提交脱敏后的真实 old-format session 文件
- 编排器默认：**A**（隐私安全）
- 理由：满足 deliverable「重现真实事故形态」之意图，同时避免把潜在敏感的真实用户 session 内容提交进仓库；与 backplane track 已接受最小化 005 fixture 的先例一致。可重现事故根因（重复读/pending effect/history 滞后）即足够过 gate。
- 状态：accepted（默认，非阻塞；用户可推翻改 B）

### 2. 【P1】CLI/TUI/headless 验收 harness 深度
- 背景：deliverable 要 CLI/TUI/headless 长运行验收 harness。
- 选项：
  - A) 聚焦 conformance run（升级真实形态 old session → 跨 CLI/TUI/headless replay 一个 turn，断言事故根因不复现 + 跨表现等价）
  - B) 全量多轮长运行 soak
- 编排器默认：**A**（audit 推荐）
- 理由：聚焦 conformance 足够验证 gate `G-migration-incident`（事故根因修复 + 跨表现一致），更省、更稳（避免长 soak 的 flaky）；与本 mission 一贯的「验证优先、最小可执行覆盖」一致。
- 状态：accepted（默认，非阻塞；用户可推翻改 B）

### 3. 【P1】提交/校验/方向审查模式
- 选项：A) 沿用前 4 track；B) 自定义
- 编排器默认：**A** — CommitMode=manual；终态 phase 挂 `<cdt:GapLoop max-rounds="5" on-exhausted="block"/>`；每个第一层 phase 挂 `<cdt:AttractorCheck use="coding"/>`。
- 理由：与 lifecycle/backplane/surfaces/multi-agent 四条已归档 track 一致。
- 状态：accepted
