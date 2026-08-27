# Design：Actor Context 与 DeepSeek 缓存成本观测

## 上下文

当前代码已经具有 provider request admission、request body observation、ProviderEpoch 与 final-success provider usage seam。新能力应当是这些 authority 的只读投影，而不是另建 cache/session store。

## 方案概览

### 1. Final-wire cache units

观察器只消费已经 admission 的 serialized request 及显式 provider/profile/model/epoch identity。它从 request 中重建有顺序的 cache-relevant unit descriptors，例如 system/message/tool schema；每个 descriptor 只包含 kind、ordinal、byteLength 和 digest，不保留正文。

连续 observation 在 identity/epoch 一致时计算最长公共前缀和两个不可混用的指标：

- `retainedPrefixIntegrity = exactRetainedPriorUnits / priorCacheRelevantUnits`。它回答前一请求的可缓存材料是否完整、原序保留；同 epoch forward-only 的硬门禁是 `1.0`。
- `reuseOpportunityCoverage = exactLcpUnits / currentCacheRelevantUnits`。它回答当前请求中有多大比例具备前缀复用机会；正常 append 后可以小于 `1.0`。

两者使用同一个显式 provider-profile unit 定义，并同时记录 byte/unit counts 与 first divergence。epoch 不同只报告 boundary，不把合法切换误判为同 epoch miss；它们也不冒充 provider 实际 `hit/(hit+miss)`。

### 2. Closed observation

输入和输出经过 own-data/exact-shape normalizer：

- 拒绝 accessor、symbol、custom prototype、sparse array、undefined、非有限数；
- provider/profile 必须来自显式配置，禁止用 provider 名称启发式猜 official；
- output deep immutable；
- request bytes、prompt 文本、tool arguments/results、API key 不进入 output。

### 3. Usage 与 normalized cost

最终成功 attempt 的 provider usage继续由现有 providerOutput/VM authority拥有。观察器只读取：

- prompt cache hit tokens；
- prompt cache miss tokens；
- prompt tokens；
- completion tokens；
- deterministic estimator 给出的 tool-surface tokens 和 Workflow-control tokens；
- 调用方显式注入的 hit/miss 权重。

normalized input cost是可比较的无货币单位：

`missTokens * missWeight + hitTokens * hitWeight`

价格权重没有提供时，只返回分项，不伪造成本。retry/failure/缺失 usage 不生成 live hit observation。

### 4. Actor 基线

同一测试任务构造三类最终请求：

1. ordinary primary/Code Actor；
2. dedicated Workflow lifecycle Actor；
3. AI Ctrl/Data Workflow node Agent。

基线报告必须列出：

- Workflow-only system/control units；
- Workflow internal tool-schema units；
- same-epoch retainedPrefixIntegrity、reuseOpportunityCoverage 和 first divergence；
-显式 epoch boundary；
- provider capability 类型（official/compatible）；
- token/cost 分项。

Track 还必须交付完整的 final-wire writer inventory。每一项记录 source writer、输入 authority、插入/替换位置、是否改变既有 prefix、epoch 语义和目标 owner，至少覆盖 progress prompt、runtime work-context、live Skill loading、provider epoch/handoff、compaction、rewind、fresh recovery、reasoning/tool pair presentation 与 provider-specific body normalization。缺少任一 mandatory writer 时 P1 RED/Gate 不得通过。

### 5. Live baseline

官方 DeepSeek 使用真实 provider cache usage contract，先预热，再执行 3–5 组等价请求并保存中位数、分位数、profile/model、request/epoch digest 与 hit/miss/prompt tokens。SiliconFlow-compatible provider 另行记录，不能补充或替代官方 baseline。

若执行环境缺少官方 DeepSeek credential/config，Track 必须报告外部 blocker；不得把 deterministic structural result、模拟 usage 或 compatible-provider usage用于勾选 live acceptance。任何 live harness 都只能读取既有 secret/config capability，不把凭据写入日志、report 或 observation。

### 6. 边界

- 观察结果可进入 test/report/metrics sink，但不进入 canonical conversation。
- 不修改 admitted request bytes。
- 不在本 Track 选择 stable superset、StageEpoch 或 hybrid 策略。
- 不使用 live provider 的单次 best-effort miss否定结构证据。

## 风险与缓解

- **token estimator 与 provider tokenizer不同**：结构和分项用于相对比较；live usage独立报告，不混为同一事实。
- **观测泄露 prompt**：只输出 digest/length/kind/ordinal，加入 adversarial closed-data tests。
- **重试双计数**：只接最终成功 usage receipt。
- **将 compatible provider 当 official**：要求显式 compatibility profile。

## 兼容性

新 observation 是 additive read model，不改变 provider wire body、conversation schema 或 snapshot authority。没有 usage 的 provider继续走现有 estimated path，但不得被标记为 live cache hit。

## 决策摘要

- Mission 已接受：缓存和 normalized token cost 是产品验收条件。
- Mission 已接受：三类 Actor 必须分开观测。
- 本 Track 无新增待决用户取舍。
