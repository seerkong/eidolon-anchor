# Design: Provider Epoch and DeepSeek Conversation Projection

## 上下文

canonical conversation 同时服务多个 provider，但 provider wire protocol 并不等价。OpenAI/Codex 历史 tool pair 不一定含 DeepSeek 可回放的 `reasoning_content`；把 raw message 直接 spread 到 DeepSeek body 会把内部字段、`undefined`、访问器或自定义原型暴露给 closed admission。切换 provider 时仅替换 adapter 还会让新 provider 继承旧 protocol continuation 的隐含前提。

## 方案概览

### 1. 单一 authority 与 Provider Epoch

- History/Conversation Domain、ToolCallDomain 继续保存完整 canonical facts，禁止第二份 provider history。
- `ProviderEpochReceipt` 是 provider materialization 的 durable projection receipt，至少绑定 actor、epoch、target provider、target protocol/profile、source conversation frontier digest、handoff digest、创建原因。
- provider/protocol 变化由现有 Conversation Domain `contextEpoch` 推进；Responses continuation baseline 同时 reset。相同 provider/profile 的普通重试不新建 epoch。
- epoch handoff 只包含 bounded、role-ordered、provider-neutral user/assistant text 与已完成 tool outcome 摘要；旧 provider tool-call framing 不进入新 epoch。原始事实仍保留在 canonical domains。
- 显式 `pending` 的首次 tool delivery 不得降格为 handoff 摘要：若目标 profile 能从现有 canonical facts 完整、无伪造地表达该 pair，则完整投影并仅在成功 completion 后确认 delivered；否则本次跨协议 epoch 激活以 typed local rejection fail closed。它不确认 delivery，也不重复执行 tool。
- 已明确 `delivered` 的 pair 可由中立 handoff 承接；没有 delivery fact 的 legacy 历史沿既有兼容规则处理为可 handoff 的既有完成事实，不反向制造“首次未交付”或强制重投全部 legacy 工具历史。

### 2. Closed Chat Wire Projection

- Chat projector按 role 重建 exact allow-list 对象，不再 `{...message}`。
- user/system/developer 只投影 role/name/content；assistant 只投影 role/content/tool_calls 以及由 profile 明确允许的 reasoning 字段；tool 只投影 role/content/tool_call_id/name。
- 所有数组必须 dense，所有对象必须 plain own-data；未知字段丢弃，结构冲突 fail closed。
- tool call/result adjacency 仍按通用 Chat contract 修复，但 provider-incompatible completed pairs在 epoch handoff前整体消隐，不能生成 orphan。

### 3. DeepSeek Compatibility Profiles

- `deepseek-official-chat`：遵循官方 Chat contract；真实 DeepSeek tool round 必须原样回放 provider 返回的 `reasoning_content`。
- `deepseek-compatible-chat`：由配置/driver 显式选择，并声明 `requiresReasoningContentForToolCalls`、`requiresAssistantContentForToolCalls`、`supportsToolChoice` 等 closed flags；SiliconFlow 不借用官方 endpoint 的未验证扩展字段。
- profile contract 版本为 `provider.chat-compatibility-profile/v1`。配置字段是 model/provider options 中的 `compatibilityProfile`（归一化为 `compatibility_profile`），值必须为 `deepseek-official-chat@1` 或 `deepseek-compatible-chat@1`。driver registry 在创建 adapter 时解析并冻结该值；unknown 值 fail closed。官方 `deepseek` provider 的 legacy 缺省迁移为 `deepseek-official-chat@1`；第三方 endpoint（包括现场 SiliconFlow）必须显式填写 compatible profile，禁止通过 URL/model/provider id 自动推断。
- `model_capabilities`、`cache_profile` 作为 runtime observation，不进入 wire body；request options 只从 profile allow-list 投影。
- 对旧 provider tool call 缺失 DeepSeek reasoning 的情况，启动新 epoch handoff；不得注入伪造的空 reasoning。

### 4. Safe Admission Diagnostics

- `ProviderRequestAdmissionError` 保存 closed diagnostic `{ code, path?, valueKind?, serializedBodyDigest? }`。
- path 是字段名/数组下标组成的 JSON pointer；valueKind 是枚举。diagnostic 不含字段值、消息内容、tool args、tool output、API key 或 request body。
- runtime-control failure evidence 与 CLI/TUI 只展示上述安全事实；同一 request digest 便于现场对齐。

### 5. 交互恢复

- provider projection/admission 失败发生在网络副作用前，main interactive fiber 记录 typed failure 后回到 suspended/recoverable 状态。
- 该 outcome 记为 typed `local_projection_rejected`（或等价 closed code），只进入 ProviderCallDomain failure 与安全 semantic diagnostic；不得合成 assistant error message、不得写 History、不得确认 tool delivery、不得推进 provider continuation baseline。
- 当前用户 turn 保持未成功交付；模型切换或相同选择重试会重新投影，不重复已完成 tool effect。
- provider 返回的真实协议/HTTP failure 仍遵守既有 retry policy，不被伪装为本地 admission 成功。

## Receipt owner 与恢复协议

- `ProviderEpochReceipt` contract 归 `ai-organ-contract` conversation/provider contract；唯一持久载体是 Conversation Domain 的 actor binding/event，不进入 Terminal、Workflow/Holon state，也不创建独立 repository。
- closed v1 identity/upsert key为 `(sessionId, actorKey, epoch)`；字段为 `schemaVersion`、`sessionId`、`actorKey`、`actorId`、`epoch`、`targetProviderId`、`targetProfileId`、`sourceMessageCount`、`pendingToolCallIds`、`sourceFrontierDigest`、`handoffDigest`、`integrityDigest`、`reason`、`createdAt`。`sourceMessageCount` 冻结不依赖时间戳的 canonical non-system 消息前缀边界，`pendingToolCallIds` 冻结首次 handoff 中完整保留的 delivery pair；`sourceFrontierDigest` 绑定该前缀的 closed role-ordered canonical source，`handoffDigest` 绑定实际 bounded role-ordered handoff 内容，`integrityDigest` 绑定 receipt 的全部 identity 与内容地址字段。provider id 必须参与 same-epoch 判定，因为两个 provider 即使共享同一 Chat profile，也不是同一个 provider epoch。
- 原子 owner 顺序：actor model-config control fact被录取 → Conversation owner比较 current/target profile → 校验 pending delivery → exactly-once推进context epoch并持久receipt → reset continuation baseline → 创建新adapter request。重复control、same-profile retry和恢复重放不得多推进epoch。
- receipt 创建时从真实 canonical source 与 bounded handoff 计算两个内容地址，再计算覆盖全部字段的 `integrityDigest`。fresh recovery 先闭合校验 identity/profile/integrity；缺失或损坏时从当前 canonical Conversation/ToolCall facts确定性重建 projection 并推进一次。每次 transport 前，以本轮实际 provider messages/current pending pairs 重算内容地址，在同一 `(sessionId, actorKey, epoch)` reconcile receipt projection 字段（内容未变则 exact no-op）后，投影器再独立复算并逐字段比较，匹配才放行网络。合法 compaction 改变 handoff 时只更新同一 epoch 的 projection receipt；handoff 不变的新 turn 保留原内容地址；二者都不推进 epoch，也不得猜测或补造reasoning。

## Processor / Effect 边界

- 纯投影：`projectProviderConversation(runtime, input, config)`，runtime 只含 profile/codec/digest 端口，不做网络 I/O。
- 模型切换 effect：Terminal 只发出 actor model/config control command；Conversation Domain owner推进 epoch并持久 receipt。
- fetch adapter 只接收 admitted request；不得重做消息投影或 provider 推断。

## TDD 与事故验证

1. RED：用事故形状的 Codex tool history + SiliconFlow DeepSeek 构造请求，要求暴露安全 invalid path；用同 session switch 验证当前失败。
2. GREEN：closed projection 与 wire allow-list；移除 runtime-only body metadata。
3. RED/GREEN：model switch 推进 epoch、handoff 不带旧 tool framing、fresh recovery保持相同 receipt。
4. DeepSeek 原生 tool round：真实 reasoning roundtrip 后 fresh recovery再次投影精确一致。
5. 复制现场：不修改原 session，在 recovery copy 上完成一次 SiliconFlow DeepSeek turn；断言一个新 completion、零重复 tool effect、fiber 可继续。

### 事故 fixture recipe

- 原件：`/Users/kongweixian/ai/ai-codument/codument/.eidolon/sessions/20260824091204__01M0S6BG41GQJG70TH8GR07QSG`。gate 必须先校验该目录存在并且是普通目录；若移动环境，则通过必填 `EIDOLON_PROVIDER_EPOCH_INCIDENT_SESSION` 传入等价只读session根，禁止猜测路径。
- 工作副本：`/Users/kongweixian/ai/ai-codument/codument/.eidolon/sessions/20260824091204__01M0S6BG41GQJG70TH8GR07QSG-recovery-copy-20260824`；实现与live gate只允许写副本。移动环境使用必填 `EIDOLON_PROVIDER_EPOCH_INCIDENT_COPY`。
- gate 前后记录原件文件树的稳定相对路径、size、mtime与SHA-256清单并要求完全相等；副本使用当前编译产物和显式 `deepseek-compatible-chat@1` 配置执行。
- deterministic结构gate不需要credential；live provider gate是外部依赖，凭据可用时要求离开local admission并记录typed远端/成功结果，凭据不可用时必须明确报告而不能替代结构gate。

## 风险 / 权衡

- 中立 handoff 不是旧 provider 原生 transcript 的逐字回放；这是跨协议安全性换取。canonical facts不删，用户可切回原 provider继续完整 replay。
- 兼容 endpoint 能力可能演进；通过显式 profile version 扩展，不在公共 projector按 URL/model name 分支。
- 事故 session 很大；live gate只读取复制现场并使用有界 provider projection，不把原始 body写入日志。

## 兼容性与迁移

- 旧 session无需批量迁移。首次跨 provider/protocol切换时懒创建 epoch receipt。
- 相同 Chat profile下的恢复保持旧 replay；只有发现不兼容 provider-native字段时才 handoff。
- OpenAI Responses native item replay保持独立，不导入 Chat projector。

## 决策摘要

- canonical conversation 单一 authority，provider epoch 是投影 receipt。
- official DeepSeek 与第三方 compatible profile显式分离。
- 本地 admission failure 可恢复，且只暴露安全结构诊断。
- 用户已明确同意上述根治方向并要求直接实现。
