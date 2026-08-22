# Proposal：验证 Eidolon Resource-native App 完整生命周期

## 背景

Mission 的通用资源、workflow domain、Eidolon host adapters、Agent resource bridge 与四 Skill 分发已经分别实现并通过各自 track。当前最后一个问题不是继续增加架构，而是从用户实际入口证明这些部分能组成一个顺畅产品：用户以普通语言创建资源原生 AI App，在独立授权后发布，再在另一次独立授权后运行并读取结果与 evidence。

过去的 authoring journey 曾出现约 142.956 秒耗时和 `invalid_tool_call_payload`。指定的 `/tmp` session 与旧 Codex JSONL 现在均不存在，因此本 track 不伪造历史回放，而以持久 incident/report 事实为基线，创建新的真实 provider session。

## 目标

- 使用当前编译并本地链接的单一 `eidolon` 程序和当前 provider preset。
- 在隔离 HOME/global/workspace 中执行 `global init`，安装四个系统 Skill。
- 以固定自然语言目标创建一个引用 exact `AIAgentDefinition` 的 Resource-native App。
- 同一 session 分三 turn 完成 create、publish、run，保持 publication 与 execution 两次独立授权。
- 读取 session、revision、proof、publication、registry、instance、run、result、events 与 replay evidence。
- 记录 wall/provider/tool/product-overhead 时间与重试事实，修复任何可复现的通用产品缺口。
- 确认 CLI、TUI 与 native component 共享同一 resource/runtime authority。

## 范围

- 真实 provider 的 compiled `eidolon workflow agent` journey。
- 隔离 harness、敏感配置脱敏、可重复 command/evidence capture。
- 对 real journey 暴露的 tool schema、Skill progressive loading、resource projection/freeze、actor/session continuation、CLI/TUI read model 或 native component问题做最小修复。
- authoring recovery、重复请求幂等、first-delivery 与产品时延验证。
- final static authority review。

## 不在范围

- 不修改或替换用户真实 `~/.eidolon`、workspace 或 provider 配置。
- 不持久化 provider credential、raw reasoning 或机器绝对路径。
- 不通过 `--model` 绕过当前 provider preset。
- 不新增 workflow-specific actor、session、history、compactor、resource registry 或 dependency resolver。
- 不在 host 中加入自然语言、App 名、workflow 名、节点标签的模糊匹配或别名路由。
- 不跳过 proof、publication authorization、execution authorization、resource freeze 或 recovery 来压缩耗时。
- 不实现 mission 明确延期的自定义 compaction prompt 或跨 workflow step 的 agent session 复用新能力。

## 成功判据

- 新 compiled product 在新隔离目录中完成 exact 四 Skill 安装和三 turn 生命周期。
- 第一 turn 不发布，第二 turn 不执行，第三 turn 才运行。
- 发布物可通过 Halfcode-backed registry 与 depa typed projections解析，Agent/Material/run freeze receipt完整。
- 外层 generic CLI session 可 continuation/recovery；fresh workflow child只接收typed durable handoff，不复用child history；CLI/TUI/native read facts一致。
- 无 `invalid_tool_call_payload`、无无进展重试、无逐文件低效编辑循环。
- product-owned overhead 达到 track 预算，端到端 provider 分量如实报告。
- 无第二 authority 或模糊 host 语义。
