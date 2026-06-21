# Wave / DAG 调度执行（std/sop/wave-exec.md）

> `codument-implement` / `codument-plan-schedule` 引用。描述 `cdt:child-mode="dag"` 的层如何调度执行。

## 派生 wave

对某 `cdt:child-mode="dag"` 的层：读 `<Schedule><Dag for="该层">` 的 `<Node id><After ref></Node>` 边 → 在该层**直接下层**上构 DAG → 计算入度 → 拓扑分层，每层即一个 **wave**（派生，不入库）。

## 调度循环

```text
@delimiter: --
-- #loop ?waves while="该层仍有未完成节点"
---- #step ?ready
ready = 该层入度为 0 且未完成的直接下层节点（= 本 wave）
---- /?ready
---- #parallel ?dispatch limit="<Parallel> max-concurrent（parallel=false 则退化为串行）"
对 ready 批次每个 Task 派子代理执行（只传路径/引用，子代理自读）
---- /?dispatch
---- #step ?collect
等批次完成 → 回写各 Task status
---- /?collect
---- #if ?spot cond="spot-check=true"
父层独立 spot-check 本 wave 产物：目标指标、行为基线、diff 面、前一 wave 成果是否被污染
---- /?spot
---- #step ?lock
spot-check 通过后，若 CommitMode=auto 则创建 wave/任务检查点；manual 模式也应在输出中建议用户尽快提交锁定，避免后续 wave 污染已验证成果
---- /?lock
---- #step ?advance
减各后继节点入度 → 生成 wave 完成小结，并把关键事实写入 tracks/<id>/analysis/findings.md
---- /?advance
-- /?waves
```

## 规则

- 默认（无 `cdt:child-mode="dag"`）按 `order` 顺序执行，不进本流程。
- 子代理只接收路径/引用（task id、Description、cdt:Acceptance、input/output MaterialBundle 路径、前置产物位置）。
- 子代理 prompt 必须写明：完成即停、不要开启超长会话；禁止 `git restore` / `git checkout` / `git stash`；遇到越界需求或前置成果异常时返回阻塞而不是自行大范围修复。
- 父层不能盲信子代理自述。每个 wave 至少检查目标指标、行为基线测试、diff 是否符合预期；对"非我责任"类说法用错误性质、HEAD 对照或复现实验验证。
- 非叶节点（TaskGroup）递归：先按其自身 child-mode 调度其直接下层。
- 失败/抽检失败/DAG 阻塞按 `validation.md` 与失败处理协议处理（重试/跳过/中止）。
