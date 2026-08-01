# Mission Design

## 控制论模型

- desired state：`mission.xml` 的 DAG 表示三个收敛方向：WIP 盘点、shell command normalization、unsupported fallback 风险分级。
- actual state：当前 git dirty worktree、已有 long-running mission/tracks、session 里 bash unsupported approval 样本、权限 parser 现有测试。
- actuation：创建并执行 shell 权限相关 tracks；追加 mission reports；必要时重规划。
- feedback：targeted tests、git diff、session 样本是否从 ask 降为 allow、危险语法是否仍被 ask/deny。

## Mission Actors

| Actor | 职责 |
|---|---|
| MissionPlanner | 把“已有未提交 WIP”和“shell 审批降噪”拆成 DAG 节点与 tracks。 |
| MissionObserver | 读取 worktree、已有 mission/tracks、权限 parser 代码和 session 样本。 |
| MissionReconciler | 判断 shell tracks 是否覆盖实际审批噪音，同时不放宽高风险边界。 |
| MissionApplier | 创建 tracks、执行 bounded patch、跑 targeted tests、写 report/status。 |

## Track 切片

1. `update-bash-command-normalization`
   - 处理可被安全规范化的命令形态：换行分段、`python3 <<EOF` / `python3 - <<EOF`、只读多行 inspection 的 parser 入口。
2. `add-bash-risk-fallback`
   - 在 parser 仍无法理解时，用 deterministic risk analyzer 区分 low-risk readonly / high-risk dangerous / unknown，避免“解析失败即审批”。

## 受控重规划

如果实现中发现 parser 改动会影响 workspace access grant、protected permission config 或 sandbox 语义，必须新增 report 并拆出额外 track，而不是把风险混入现有两个 tracks。

## 风险 / 权衡

- 风险：过度放行 unsupported shell syntax。
  - 缓解：fallback 只对明确只读、无 protected config 写入、无危险 token 的命令放行。
- 风险：Python `-c` / heredoc 检测误判写入脚本。
  - 缓解：只把 Python inspection 限定在无明显写入 API、无 subprocess/system、无 network import 的脚本。
- 风险：已有 runtime WIP 被误改。
  - 缓解：shell tracks 只触碰 permission evaluator 及其 targeted tests。
