# Decisions

## Usage
- 记录需用户确认的决策问题、选项、最终结论与理由
- 后续执行中出现的新决策继续追加本文件

> 来源：用户要求「先建一个 track 把 (b)/(c)/(a) 三个小改动做了，然后归档；再专心排查单轮内 repeat-read」。

### 1. 【P0】实现顺序：风险升序（a→c→b）vs 用户 priority（b→c→a）
- 背景：scoping audit 实测 (a) 与 (c) lever1 = SMALL/无 recovery 风险；(b) = MEDIUM-LARGE（恢复一致性是真实工作量）。先做 (c) 的 O(n²) 序号修复还能让 (b) 调试不被 389MB 重解析风暴干扰。
- 决策：**按风险升序实现**——P1=(a)，P2=(c)，P3=(b)，P4 closure。覆盖用户要求的全部三项，仅调换实现次序以降风险。
- 理由：(b) 最大最险放最后、在已修好的安静 journal 上做；(a)/(c) 先落地零风险价值。用户「三个小改动」措辞 + audit 复杂度评估共同支持此序。
- 状态：accepted（编排器默认；用户可推翻回 b→c→a）

### 2. 【P0】(b) 范围：minimal-first + 恢复一致性子步
- 背景：(b) 的 flush 调用 trivial，但 flush 后 history.xnl 领先 VM snapshot，恢复门（`RuntimeSnapshots.ts:269-298`）需容忍 conversation-ahead-of-snapshot。audit：若已容忍=MEDIUM，若门需改=LARGE。
- 决策：(b) **minimal-first**——超时分支调 `flushConversationRuntimeToPersistence` 只 seal 已完成对；**显式子步**先证明/调整恢复对 conversation-ahead-of-snapshot 的容忍。**若恢复门工作证明为 LARGE/触及不变量**，(b) 标 partial 并把恢复门改造拆为后续 track，不在本「小改动」track 里强推。
- 理由：守住「不快照不安全工具执行中」不变量；避免把一个大改动塞进小 track。
- 状态：accepted

### 3. 【P1】提交/校验/方向审查模式
- 决策：沿用近 5 条 track——CommitMode=manual；终态 phase 挂 `<cdt:GapLoop max-rounds="5" on-exhausted="block"/>`；每个第一层 phase 挂 `<cdt:AttractorCheck use="coding"/>`。
- 状态：accepted

### 4. 【范围】不在本 track
- **单轮内 repeat-read 非收口**（真实 session 的主 bug）= 独立后续排查，**不在本 track**。本 track 只做 (a)(b)(c) 三项健壮性改进。(b) 明确**不治**单轮内 loop。
- 状态：accepted
