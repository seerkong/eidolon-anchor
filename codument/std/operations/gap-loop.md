# skill: codument-gap-loop（目标差距收敛）

GapLoop 让父层编排器控制轮次，每轮由 fresh 子代理独立比较实际态与目标态、修复可处理差距并留下证据。它可以作用于 Track、某个 phase 或 Mission。

## 角色

- 父层：确定 scope、轮次、输入、配置和续轮条件；更新 authority；读取子代理 verdict。
- fresh 子代理：只处理当轮 scope，读取事实、运行验证、写 `reports/`、修复范围内问题并返回简洁 verdict。
- Mission 调用 Track GapLoop 时，Track 父层收口后把结果交还 MissionApplier；局部收口不是 mission invocation 的返回边界。

## 输入与目标态

Track/phase scope 读取 `track.xnl`、proposal、design、behavior deltas、Acceptance、相关代码测试和上一轮报告。Mission scope读取 `mission.xnl`、proposal、design、reports、ProjectRef binding 及 bound Track 的真实 authority。

目标态来自这些 authority 的共同约束。实现、测试、reports 和 linked resource 是实际态。冲突时先报告 authority 冲突，不凭上下文猜测目标。

## 初始化

1. 定位 Track 或 Mission，解析目标 scope 上的 `GapLoop` 配置；显式命令没有 hook 时按当前 Kind spec 补齐配置并运行 validate。
2. 读取 `max_rounds`、`on_exhausted` 与 `verify_round`；未配置时使用当前 spec 默认值。
3. 运行 `codument validate <id> --strict`，确认 authority 可执行。
4. 开始第 n 轮前运行：
   - `codument track gap-round <track-id> <n>`
   - 或 `codument mission gap-round <mission-id> <n>`

CLI 负责根属性、时间和 Mission revision 的一致写回。

## 每轮

1. fresh-spawn 子代理，只注入 scope、authority 路径、上一轮报告（如有）和 verdict 格式。
2. 子代理读取实际文件并运行与目标相称的测试、lint、构建或资源校验。
3. 子代理先写 issues-first 的 `reports/gap-<scope>-<round>.md`。
4. 无差距时返回 `NO_GAP`；能在 scope 内修复时完成修复和验证后返回 `FIX_APPLIED`；需要用户决策或外部状态时返回 `BLOCKED`。
5. 父层核对 report 路径和实际 diff，再决定续轮。

## 续轮

- `FIX_APPLIED`：开始下一 fresh 轮，聚焦上一轮改动与可能的回归。
- `NO_GAP`：通常收口；当 `verify_round=true` 且这是无历史首轮时，再运行一轮轻量确认。
- `BLOCKED`：记录 blocker。若当前属于 Mission 子 Track，先交还 MissionApplier 尝试重规划或其他 ready 分支；只有 mission 也无法继续时才向用户返回 blocked。
- 达到 `max_rounds`：执行 `on_exhausted` 定义的状态，并报告仍未闭合的差距。

轻量确认只读取上一轮报告、相关 diff 和必要验证，不重复全量分析。

## 子代理返回

```text
status: NO_GAP | FIX_APPLIED | BLOCKED
summary: <本轮结论>
evidence: <gap report 和关键验证>
```

这是子流程通信，不创建独立 XNL/XML receipt。父层依据 verdict 和真实文件继续控制循环。

## 完成条件

最后一轮为可收口的 `NO_GAP`，authority 与报告已验证，gap round 与相关 Track/Mission/task 状态已由对应生命周期命令更新。Hook 本身没有运行期 status 字段。Mission 中的子 Track 随后立即返回 MissionApplier 继续 mission observe/reconcile 或下一 ready operation。
