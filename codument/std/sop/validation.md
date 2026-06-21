# 校验 / 纠偏 / 确认协议（std/sop/validation.md）

> 从原 `std/protocols.md` 拆出的「门控与纠偏」域。这是 `track.xml` / `operation-hooks.xml` 里 `cdt:` hook 的**执行协议**（节点格式见 `std/spec/track-xml-spec.md §6`）。

## 裁决词汇（统一）

审查/纠偏类 check 返回结构化裁决 + summary。一般审查（如 AttractorCheck）用 `status ∈ PASS | GAP | BLOCKED`，`GAP` 修复后**必须重跑该 check** 直到 `PASS` 或 `BLOCKED`。**gap-loop 有专属三态** `NO_GAP | FIX_APPLIED | BLOCKED`（`NO_GAP`≈PASS；`FIX_APPLIED`=本轮发现并已修复、**须复检**；见下）。

## 协议

### cdt:HumanConfirm
人工确认门控：到确认点 **yield 给用户**审阅后再继续。未通过则修复后重新确认，直到通过。暂无属性。

### cdt:GapLoop（有界目标对比修复 · 双角色）
**双角色协议**：父层编排代理只做轮次控制，每轮 **fresh-spawn** 一个独立子代理对比 scope 实现 vs 目标（proposal/design/behavior_deltas + `cdt:Acceptance`）→ 写 gap 报告（`track://reports/`）→ 必要修正 → 返回结构化 XML（`status ∈ NO_GAP|FIX_APPLIED|BLOCKED`）。父层据 XML 续轮：`FIX_APPLIED`**不算完成**必续轮复检；**首轮+无历史+NO_GAP 不得收口**（首轮怀疑），再验证一轮；非首轮 `NO_GAP` 才收口。属性 `max-rounds`（上限）/`on-exhausted`（`block` 等）。**完整协议（角色判定、模式补齐、禁止事项、输出 XML 契约）见 `gap-loop.md`。**

### cdt:AttractorCheck（方向审查）
派发 **fresh-subagent**，按 `use="<profile>"` 指定的 attractor profile（`config/attractor-profiles.xml`）对照吸引子审查当前 scope 是否偏离方向 → 返回裁决；`GAP` 按所在节点/默认策略修复复检。**执行器固定 fresh-subagent**（本协议约定，不在节点上配）。

## 通用规则

- **校验模式塌缩**：track 的"校验模式/粒度" = 在终态 phase（final）或每个 phase（every）挂 `cdt:GapLoop` 或 `cdt:HumanConfirm`。
- **顺序**：phase 与 task 同时配置时，phase-before → task-before → task-after → phase-after。
- **归属**：若上层（operation-hooks 或上层节点 hook）已拥有某 scope 的纠偏，下层不要再起竞争性 check，读已有结果即可。
- **无隐式等待**：未配置 hook 时，不因 attractors/ 存在就额外暂停。
