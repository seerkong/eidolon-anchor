# Decisions

## Usage
- 记录需用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母仅用于选项
- 后续执行中出现的新决策继续追加本文件

### 1. 【P0】读侧隔离范围
- 背景：G-surface-readonly 复评确认 push-projection 侧已达标（零 surface 写 domain truth、零反向 gate），残留全在读/拉取侧（6 项，见 analysis/findings.md）。
- 选项：
  - A) 全部读侧残留（#1 hydration→port + #2 pending-questions→port + #4 新类型化 ConversationProjectionReadPort 契约 + #5 跨 surface 等价测试 + #6 扩展 boundary guard）
  - B) 核心读端口 + 测试（#1/#4/#5/#6），#2 推后
  - C) 最小（#1 + #5）
- 用户答复：A（2026-06-16）
- 最终决策：A — 完整兑现 mission Track-7 读侧隔离：把 TUI hydration + pending-questions 改接到类型化 projection-read port、新增只读契约、补跨 surface 等价测试、扩展 boundary guard 覆盖 TuiRuntimeClient。
- 决策理由：一次把读侧事实边界做硬，避免 surfaces 反复触碰单源读取脆弱面；与 backplane 提供的 read port 直接衔接。
- 状态：accepted

### 2. 【P0】session.delete 规则五隐患处理
- 背景：`TuiRuntimeClient.ts:1764-1777` 的 `session.delete()` 从 surface 直接 `rm` 整个 session 目录（含 domain-truth conversation 文件），违反「规则五：projection 不能反写/销毁上游真源」，且无 domain 能力中介（对比 upgrade 已走 shared capability）。
- 选项：
  - A) 本 track 内经 domain-owned 删除能力路由
  - B) 推给后续 track
- 用户答复：A（2026-06-16）
- 最终决策：A — 在本 track 把 surface 的 session 销毁改为经 domain-owned 删除能力中介，surface 不再直接 rm session 真源目录。
- 决策理由：这是 surface→上游真源的破坏性反写，正属本 track 的只读隔离主旨；与读侧改接一并收口最自然。
- 状态：accepted

### 3. 【P1】提交/校验/方向审查模式
- 背景：与刚归档的 refactor-persistent-session-backplane 保持一致的执行模式。
- 选项：
  - A) 沿用 backplane：manual 提交 + GapLoop 仅终态 phase（max 5, block）+ AttractorCheck use=coding 每个 phase
  - B) 自定义
- 用户答复：A（2026-06-16）
- 最终决策：A — CommitMode=manual；终态 phase 挂 `<cdt:GapLoop max-rounds="5" on-exhausted="block"/>`；每个第一层 phase 挂 `<cdt:AttractorCheck use="coding"/>`。
- 决策理由：执行模式与上一条 mission track 一致，便于编排与复评。
- 状态：accepted
