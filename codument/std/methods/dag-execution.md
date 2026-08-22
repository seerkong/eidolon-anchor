# Wave / DAG 调度执行（std/methods/dag-execution.md）

> `codument-impl-track` 与 `codument-maintain-track` 的 `schedule` mode 引用。描述 `{ child_mode = "dag" }` 的层如何调度执行。

## 派生 wave

对某 `{ child_mode = "dag" }` 的层：读 `<Schedule []>` 中 `<Dag { for = "该层" }>` 的 `<Node #id>` / `<After { ref = "..." }>` 边 → 在该层**直接下层**上构 DAG → 计算入度 → 拓扑分层，每层即一个 **wave**（派生，不入库）。

## 调度循环

```text
@delimiter: --
-- #loop ?waves while="该层仍有未完成节点"
---- #step ?ready
ready = 该层入度为 0 且未完成的直接下层节点（= 本 wave）
---- /?ready
---- #parallel ?dispatch limit="<Schedule { max_concurrent = N }>（缺省时由执行器保守选择，无法安全并行则串行）"
对 ready 批次每个 Task 调用 impl-track 的 execute-task。DAG 只声明 readiness；当前 AI 可按任务边界、文件重叠、上下文连续性与并行收益选择 local、delegated 或混合执行，不因 ready/leaf 身份强制委派
---- /?dispatch
---- #step ?collect
等批次完成 → track executor 对成功节点逐项运行 `codument track task complete <track-id> <task-id> -- <verification-command>`；失败、拒绝或放弃才使用 `task transition` 写对应非 DONE 状态
---- /?collect
---- #if ?spot cond="<Schedule { spot_check = true }>"
track executor 做 wave 级客观复核：目标指标、行为基线、diff 面、前一 wave 成果是否被污染；委派结果不得以 worker 自述代替复核
---- /?spot
---- #step ?lock
spot-check 通过后，若 CommitMode=auto 则创建 wave/任务检查点；manual 模式也应在输出中建议用户尽快提交锁定，避免后续 wave 污染已验证成果
---- /?lock
---- #step ?advance
减各后继节点入度 → 生成 wave 完成小结，并把关键事实写入 tracks/active/<id>/analysis/findings.md
---- /?advance
-- /?waves
```

## 规则

- 默认（无 `{ child_mode = "dag" }`）按 `order` 顺序执行，不进本流程。
- DAG 决定哪些节点 ready，不决定由谁执行。没有真实并行收益、任务修改同一文件、当前上下文已经充分或 runtime 不支持协作时，顺序 local 执行是正常策略。
- 使用 delegated 策略时只传路径/引用（task id、Description、Acceptance、input/output MaterialBundle 路径、前置产物位置）；worker 不修改 `track.xnl`、acceptance、findings 或 commit。
- delegated prompt 必须写明：完成即返回产物与证据（stop 仅限子流程边界，调用方决定是否继续）、不要开启超长会话；禁止 `git restore` / `git checkout` / `git stash`；遇到越界需求或前置成果异常时返回阻塞。
- 若该 DAG 执行发生在 `codument-impl-mission` 的子 track / 子流程内，local/delegated worker 或局部 track 流程的返回必须交回 mission 父层，由 mission 父层继续更新状态并推进后续 ready operation。
- executor 不能盲信 delegated worker 自述。每个 wave 至少检查目标指标、行为基线测试、diff 是否符合预期；对"非我责任"类说法用错误性质、HEAD 对照或复现实验验证。
- 非叶节点（TaskGroup）递归：先按其自身 `child_mode` 调度其直接下层。
- 失败/抽检失败/DAG 阻塞按 `validation.md` 与失败处理协议处理（重试/跳过/中止）。
