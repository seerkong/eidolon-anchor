# 变更：优化 AI Workflow 编辑控制环与发布事实契约

## 背景和动机 (Context And Why)

真实 AI Workflow 编辑 session 从接收需求到 durable publication 共耗时约 `142.956s`。其中 child actor 在发布前经历 12 次模型 completion，累计 first-token wait `47.860s`、generation `87.446s`，原生工具执行仅约 `0.430s`；第一次 workspace mutation 在约 `95.36s` 后才发生。问题主要不是文件 I/O，而是模型轮次、重复推理、一次一文件的 mutation 协议和发布前后事实契约不完整。

同时，现有实现把 `WorkflowGetAuthoringSummary` 称为 compact summary，却直接返回完整 session metadata；`WorkflowListAuthoringSessions` 也返回完整 validation binding 和 dry-run projection。这是 AI Workflow 工具边界的领域 read-model 问题，不是上下文压缩问题。Eidolon 已有通用 `ContextCompressor`、Conversation materialization 和 provider-context compaction，AI Workflow 不应另建压缩、缓存或 history authority。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 把 AI Workflow 编辑链路收敛为 target-first、少轮次、可测量的控制环，显著提前首次 mutation。
- 增加带 expected revision 的原子多文件结构化 patch，一次提交一个 coherent bundle change；失败时不留下部分写入。
- 建立 `baseRevision / workingRevision / publishedRevision / dirty / publicationReceipt` 等明确事实，修复发布后继续编辑仍显示 published、diff 把全部文件算作 created 等问题。
- 将 diff、validation、static projection、build、隔离 candidate acceptance disposition 和 publication proof 绑定到同一 exact revision；static projection 继续是必需 proof，但不再冒充 effectful runtime acceptance，发布前测试不得访问真实网络或产生真实业务副作用。
- 让 high-level authoring 返回 typed receipt，父 actor 不再重复解析自然语言、重复读取完整 summary 或重跑已完成 proof。
- 在 workflow tool adapter 边界提供分页且有硬上限的 typed brief/summary projection；完整 session authority 仍由 session store 和 `WorkflowWorkspace describe` 按需读取。
- 通过 Eidolon 通用 actor context policy 让多轮 delegate 复用现有 compaction；禁止 workflow-specific compression、tool-name 特判或平行 history。
- 将 raw reasoning delta 设为显式 debug retention，常规诊断只持久化聚合 turn/tool/proof timing 与 receipt identity。
- 保持所有模糊语义由 `sys-ai-workflow` 和模型处理；确定性代码只消费显式 stage、operation、revision、receipt 和 authorization。

**非目标：**

- 不实现 AI Workflow 自定义 agent 压缩提示词；该能力由后续独立 track 设计。
- 不实现 workflow run 返回 Eidolon agent session id，也不实现后续步骤复用前序 agent session；该能力由后续独立 track 设计。
- 不新增 AI Workflow 专属压缩器、缓存、conversation store、provider history 或 token-budget 真源。
- 不用正则、关键词、substring 或启发式规则判断 stage、审批、场景、负责人、拓扑或业务分支。
- 不以跳过 canonical validation、acceptance disposition/policy gate、publication authorization 或 execution authorization 换取速度。
- 不改变其他 Eidolon 工具的输出契约；summary projection 的兼容调整仅限 AI Workflow authoring tools。

## 变更内容 (What Changes)

- 增加事故级 authoring latency harness，分解 provider wait、generation、tool duration、payload size、first mutation 和 proof/publication timing。
- 增加结构化 `WorkflowApplyAuthoringPatch`/等价 component operation：多文件 add/update/delete、expected revision、全量预检、原子 commit 和一次 proof invalidation。
- 版本化 authoring session metadata，明确 working/published 两条 revision 线、dirty projection、append-only publication receipts、latest receipt projection 和发布后 baseline rebase。
- 增加 `WorkflowAuthoringSessionBrief` 与 `WorkflowAuthoringSummary` read model；list/summary 工具不再返回完整 binding/projection，详细 authority 继续按需读取。
- 增加 exact-revision static projection/build/acceptance disposition receipts 和 deterministic prepare-publication pipeline；`required` acceptance 只通过 canonical runtime + 注入式隔离 effect fixture 验证，`not_required` 必须携带 canonical manifest/profile/显式结构化 policy source。
- 让 publish gate 校验 receipt identity/digest/revision/disposition，并在成功 readback 后追加 immutable publication receipt；真实 public-source execution 只允许在发布后取得独立 execution authorization 后发生。
- 模型只请求 terminal transition；`WorkflowAuthoringReceipt` 由 component/session authority 从持久化 revision/proof/publication facts 生成，父层仅校验 receipt identity，不做重复 verification。
- 将 actor history compaction eligibility 改为通用 actor context policy；多轮 delegate 默认参与，单工具短生命周期 actor 可显式关闭。
- 调整 `sys-ai-workflow` 的 coding/testing/releasing 协议：模型先确定目标文件，使用原子 patch 和 prepare-publication 工具，不在 reasoning 与 tool args 中重复完整源码。
- 常规可观测性保留聚合指标与结构化 receipts；逐 delta reasoning 仅在显式 debug 策略下保留。

## 影响范围 (Impact)

- 受影响 behaviors：`eidolon-ai-workflow-native-capability`、`ai-semantic-conversation-spine`、`ai-runtime-observability-rx-sinks`。
- 受影响代码：workflow authoring session/component/tools、WorkflowAuthor high-level result contract、generic actor context policy/compaction、system AI Workflow Skill、runtime observability sinks、相关 CLI/TUI/native tool tests。
- 兼容边界：`WorkflowAuthoringSessionStore.describe/list` 保留完整 authority 语义；精简发生在 workflow tool adapters/read models，不影响其他工具。

## 验收方向

- 同一双文件编辑用例的 scripted provider authoring completion 数从基线 12 降至不超过 6，首次 workspace mutation 不晚于第 4 次 completion。
- real-provider 回放必须输出与 `142.956s` 基线同口径的分阶段报告，并证明编辑耗时下降；任何 proof、publication 或语义 authority 不得被削弱。
- 发布后 session 的 working/published/dirty 状态、diff baseline 和 receipt identity 一致；发布后 mutation 不会把未发布工作误报为 published。
- list 按稳定顺序分页（默认 20、最大 100，含 cursor/total/truncated）；summary 中集合字段有硬上限，完整 diagnostics/binding 只能通过显式 detail read 获得。
- generic delegate compaction 测试通过，源码不存在按 workflow/tool 名称决定压缩的分支。
- public multi-source workflow 的成功、单源失败降级、全部 required source 失败先由发布前隔离 fixture 验收覆盖；真实 public-source 结果只能由发布后的独立 execution authorization 与 execution receipt 覆盖。
