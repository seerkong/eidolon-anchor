# Design：isolate-workflow-lifecycle-and-control-provider-cache-cost

## 1. Mission 控制模型

Desired state 不是“某个缓存测试通过”，而是三类 Actor 的能力边界和完整 provider 成本同时收敛：

```text
普通 primary / Code Actor
  └─ 通用 Conversation + 显式业务工具

AI Ctrl/Data Workflow 节点 Agent
  └─ 通用 Agent runtime + frozen task/node execution facts

Workflow 生命周期 Actor
  └─ 通用 Agent runtime
      + WorkflowLifecycleCapability
      + Workflow internal tools
      + frozen DevOps Skill revision
      + Workflow lifecycle profile
```

Actual state 来自最终 provider request body、Actor capability projection、conversation/profile snapshot、provider epoch receipt、streamed usage、fresh-process recovery、真实产品旅程与 live provider observation。Mission 每完成一个节点都重新比较 actual/desired；偏差通过 replan 或 gap-loop 收敛，不允许仅凭 focused tests 继续向后。

## 2. Actor 与 authority 边界

### 2.1 普通 Actor

- 没有 planning/coding/testing/releasing 等 Workflow stage。
- 不持有 Workflow progress profile。
- `tools: "*"` 只表示该 Actor 已录取 capability/resource capsule 中的全部工具，不表示进程内所有链接工具。
- 若需要创建或运行 Workflow，只看到公开 gateway，例如既有 `WorkflowFulfill` / `WorkflowAuthor`，由 gateway 创建专用 Workflow lifecycle Actor。

### 2.2 AI Workflow 节点 Agent

- 由 AI Ctrl/Data Workflow 的冻结 definition/task binding 派生。
- 上下文 authority 是 runId、nodeId、generation、task/claim/attempt、AgentDefinition 与显式 material/effect facts。
- 不因“处于一个 AI Workflow 中”自动获得 DevOps Skill、Workflow lifecycle stage 或内部 authoring tools。
- 节点之间的 Agent continuity 继续使用既有 `runAgent` / `runTargetedAgent` 与通用 actor/session authority，不借用 Workflow lifecycle profile。

### 2.3 Workflow 生命周期 Actor

- 是唯一拥有 Workflow lifecycle state machine 的 Actor。
- 内部 tools、stage policy、progress profile 和 DevOps Skill 由专用 capability/capsule 注入。
- lifecycle facts 由 typed profile/facet 持久化；generic actor snapshot 只认识中性 extension/profile slot，不认识 Workflow 字段。
- 通用 executor 通过中性的 Actor lifecycle/policy port 调用扩展，不能 import Workflow 实现。

## 3. Provider context 不变量

### 3.1 同 epoch 前缀规则

对连续 provider request `R(n)` 和 `R(n+1)`，只要没有显式 epoch transition：

1. `R(n)` 中仍被保留的每个 cache-relevant item 必须在 `R(n+1)` 中保持同一顺序和 canonical bytes。
2. 新 user/assistant/tool facts只能追加；不得在 stable root 与旧 history 之间插入每轮变化的 overlay。
3. provider-visible tool schema 若属于同一 surface epoch，名称、顺序、description 和 schema bytes 必须稳定。
4. runtime progress/timeout/deadline enforcement 留在 runtime；确需告知模型时追加 typed fact，不能替换旧 system prompt。

### 3.2 合法 epoch 边界

- provider 或 model compatibility profile 变化；
- compaction 接受并推进 canonical continuation baseline；
- rewind/fork/history head movement；
- 显式接受新的 frozen Workflow Skill/resource revision；
- 经决策批准的 Workflow stage capability surface epoch（若成本实验选择该策略）。

每个边界必须持久化 reason、source frontier、target profile/surface 与 digest receipt；fresh recovery 重建同一结果。普通 forward turn、progress counter 更新或 late work status 变化不是 epoch 理由。

## 4. Context mutation 清单与目标归属

Mission 的第一个 Track 必须从最终 request body 反向追踪所有 writer，至少覆盖：

- stage system prompt replacement；
- `exposeProgressBudget` 一类随 turn 变化的 system message；
- `ContextControlPlane` runtime work-context / late-status overlay；
- stage tool schema presentation与执行 allowlist；
- system Skill 的 live reread；
- provider-epoch handoff、compaction、rewind 与 recovery；
- reasoning/tool pair presentation；
- provider-specific body normalization。

处理原则是“将事实放回 owner”，不是把动态内容简单拼到另一个 prompt 字符串中。

## 5. DeepSeek 缓存和成本指标

Mission 同时观测三层指标：

1. **Structural prefix coverage**：由最终 admitted/serialized provider body 计算前后请求 cache-relevant units 的最长公共前缀；同 epoch retained prefix 要求 100%。
2. **Provider cache coverage**：官方 DeepSeek 使用最终成功 response 的 `hit / (hit + miss)`；由于服务端缓存是 best-effort，live E2E 使用 warm-up 分组和中位数，不以单次请求判死刑。
3. **Normalized provider input cost**：分别记录 miss tokens、hit tokens、tool-schema tokens、Workflow control tokens，并用测试运行时显式注入的价格权重计算；报告不得只展示 token 总量或命中率之一。

G1 先形成 stage-free control journey 与等价 Workflow journey 的基线，然后批准预算。默认硬不变量是：

- 非 Workflow Actor 的 Workflow-only prompt/tool overhead 为 0；
- 同一 epoch 无 recurring structural miss；
- live 官方 DeepSeek 不得出现由本地 request mutation 导致的持续 miss；
- Workflow control/tool surface 的额外成本必须有分项、上限和选择依据。

数值型 live SLO 在 G1-T2 根据多组基线批准并写入 durable decision/behavior；后续 Track 不得自行放宽。

## 6. Provider surface 策略实验

G4 必须在同一产品任务上比较，而不是预设答案：

- **稳定全集**：跨 stage 保持完整 Workflow tool schema，换取跨 stage 前缀稳定，但可能增加每轮 token 与模型选择噪声。
- **StageEpoch**：每个 stage 使用较小 frozen schema，stage transition 产生一次解释清楚的 cache miss。
- **混合方案**：稳定的小型 control-plane tools + stage-scoped capability capsule。

选择依据是 normalized total cost、正确性、工具误选率、恢复稳定性和实现边界。无论选哪一种，execution authorization 始终由当前 typed lifecycle authority 控制，不能从 provider-visible schema 反推权限。

## 7. E2E 证据矩阵

### 7.1 PR-safe deterministic E2E

从产品入口走完整链路：

```text
Session/Actor
 -> Conversation Domain
 -> PromptPlan / Actor capability projection
 -> ProviderEpoch
 -> DeepSeek driver
 -> request admission
 -> serialized final HTTP body observer
```

至少覆盖：

- 普通无工具多轮；
- 普通 Code `tools: "*"`，证明不含 Workflow internal tools；
- tool call/result、reasoning/tool pair、parallel/pending delivery；
- 503 retry，同一 attempt policy 下 final body/epoch 稳定且不重复 effect；
- fresh process snapshot/recovery；
- Workflow 同 stage 多轮和真实 stage transition；
- AI Ctrl/Data Workflow 节点 Agent stage-free；
- compaction、rewind、reset、provider/model switch；
- long context、多 Actor、多 session；
- live Skill 更新不改变旧 Actor 的 frozen revision，新 Actor 显式得到新 revision；
- 完整 Workflow authoring→coding→testing→releasing journey，每次 miss 都映射到 epoch receipt。

### 7.2 Live provider E2E

- 官方 DeepSeek 是 hit/miss usage 的权威 live contract。
- SiliconFlow DeepSeek-compatible 单独验证 request compatibility 与其实际暴露的 usage；不伪装成官方字段保证。
- 每个场景采用预热后 3–5 组观测，保存中位数、分位数、provider/model/profile、request digest 和 epoch reason。
- live provider 不稳定导致的无结果是观测失败，不能用 deterministic test 冒充 live hit 证据；同时也不能因一次 best-effort miss 误判结构回归。

## 8. Track DAG 与交付边界

1. `characterize-actor-context-and-deepseek-cache-cost`：最终-wire writer inventory、三类 Actor RED、离线结构指标、live baseline、预算提案。
2. `extract-workflow-lifecycle-actor-capability`：内部工具/capability 隔离、中性 extension port、Workflow profile facet、节点 Agent 隔离。
3. `replace-workflow-context-mutation-with-typed-facts`：移除动态前缀改写、冻结 Skill/resource、明确 epoch transition 与 recovery。
4. `optimize-workflow-provider-surface-and-deepseek-cache-cost`：完成三种 surface 策略实验，实施获选策略并满足预算。
5. `add-deepseek-cache-coverage-and-cost-product-e2e`：建立 deterministic/live 产品门禁、可观测报告和故障矩阵。
6. Mission 级 fresh AttractorCheck、gap-loop 与独立 verify：验证最终组合态，不重复实现代码。

所有候选 Track 都必须先用 `codument-plan-track` 创建自包含 behavior delta、proposal、design、TaskSpace 和 acceptance；再由 `codument-impl-track` 执行。一个 Track 的 DONE 不自动证明 Mission 的下一阶段可开始，MissionReconciler 必须先审核 actual evidence。

## 9. 受控重规划条件

- 若 baseline 证明主要成本来自 provider 计费或远端 cache policy，而非 request mutation：保留隔离目标，调整 G4 的成本策略，不伪造本地修复。
- 若 generic executor 无法在不破坏现有 Actor snapshot 兼容性的情况下立即移除 Workflow 字段：先建立 versioned profile migration Track，禁止长期双写。
- 若稳定全集比 StageEpoch 显著更贵：允许选择 StageEpoch/hybrid，但必须将 stage transition 变成显式 epoch 并证明只有一次 miss。
- 若官方 DeepSeek 与 SiliconFlow usage 字段不一致：分别建 capability profile，不以 provider 名称启发式匹配。
- 任一实现引入第二 Conversation/History/Session/compaction authority、让节点 Agent 获得 DevOps stage、或用丢 history 换 cache：立即停止并 replan/block。
- 任一 fresh AttractorCheck 发现 P0/P1：不得勾选终态 Gate；必须写 gap report 并完成 bounded repair/recheck。
