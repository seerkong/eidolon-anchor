# Design：Resource-native App lifecycle acceptance

## 1. 验收对象

本 track 验收的是一个产品闭环，而不是单个测试 helper：

```text
compiled/local eidolon
  -> isolated global init
  -> four installed Skills
  -> workflow agent (one outer durable CLI session)
  -> authoring source revision + proof
  -> explicit publication receipt
  -> Halfcode registry + depa projections
  -> explicit instance/run
  -> generic actor/provider/tool/session runtime
  -> result/events/replay evidence
```

Halfcode 继续拥有 ResourcePackage/Catalog/KindDefinition、layer、content identity 与 dependency snapshot。depa-flows 继续拥有 App/Workflow/Agent/Material typed projection和 run-freeze 语义。Eidolon 只拥有 host roots、global init、native tools、authoring/publication/runtime stores、通用 actor/provider/tool/session 与 CLI/TUI surfaces。

## 2. 隔离 harness

每轮创建新的 mktemp 根，包含独立 HOME、global root 与 workspace。当前用户配置中的 `llm-provider.json` 和 `agent-present.json` 只复制到临时 HOME 的 `.eidolon`，权限收紧，运行后不进入仓库或报告。报告只记录 preset/provider/model 的非敏感 identity、时间和 stable diagnostic code。

真实 `~/.eidolon` 不执行 init，不读取或替换旧 Skill tree。compiled `dist/terminal/tui/eidolon` 与 `command -v eidolon` 必须解析到同一当前 build/version；验收命令使用显式 binary path与临时 root。

## 3. 固定自然语言与授权顺序

目标保持业务语言，不向模型教授具体 XNL：创建一个接收主题文本、调用 exact reusable `AIAgentDefinition` 生成简短摘要并返回的资源原生 AI App。

只有外层 generic CLI session 由 `--session` 延续。每次 `WorkflowFulfill` 可以创建 fresh child actor；child conversation/history 不是跨 turn authority。每次 turn 从现有 stores 解析 typed handoff：authoring session + expected revision/proof，随后是 publication receipt/ref，再随后是 instance/run identities。

同一显式外层 session 执行：

1. create turn：明确“不发布、不运行”；必须返回 recoverable authoring session、working revision、proof/preparation facts。
2. publication turn：明确授权发布但不执行；只能发布 exact prepared revision。
3. execution turn：明确授权部署/运行并提供输入；返回 instance、run、result 与 evidence identities。

本 track 依赖 `publish-resource-native-app-packages-from-authoring`：它必须先提供真正的 ResourcePackage candidate、Halfcode proof、workspace resource-root atomic publication、registry refresh/readback。若该 prerequisite 未完成，P1 不得开始。任何 `vfs://` workflow bundle都不能改名为 resource receipt。

隔离 workspace 的唯一 ResourcePackage baseline包含 exact KindDefinitions/catalogs、一个固定 reusable `AIAgentDefinition`、它的 exact Prompt reference，以及 App/Workflow/Material所需 kinds。自然语言 authoring在同一 package transaction中增加/更新 App与Workflow，发布后既有 Agent/Prompt必须保持不变。

## 4. Provider 与失败模型

P2/P4 必须至少有一次真实 provider journey。deterministic fixtures只用于精确复现 schema、recovery、timing projector 或 boundary regression，不能替代最终 journey。

provider timeout、rate limit、network failure 或长 provider wait 以 provider call facts记录；external failure 可以阻塞该次观测，但不能触发 host semantic fallback。`invalid_tool_call_payload`、tool schema mismatch、first-delivery loss 或无进展 retry 属于产品事实，必须复现并在通用 owner修复。

## 5. 修复边界

允许修改通用 JSON schema/tool envelope、generic Skill loading、existing actor/session/context-policy/tool-result delivery、Halfcode-backed adapter/depa projection接缝、native WorkflowComponent transitions与 shared CLI/TUI read model。

禁止自然语言、节点名、App/workflow 名的 regex/keyword/substring/fuzzy/ordered/alias rule，禁止 workflow-specific history/session/compactor/provider/tool runtime，禁止第二 manifest scanner/catalog/dependency resolver，禁止手工 Flow DSL 或系统 Skill副本，禁止自动补 publication/execution authorization。

## 6. 时延与 recovery

每 turn 保存 started/completed、provider started/first-token/completed、tool start/completed、重试与 terminal receipt timestamps。wall、provider、tool 与 residual product-owned区间必须互斥；provider在 first token前失败时，整个 startedAt到completedAt仍归provider interval。timeout-triggered abort和user cancellation由 typed abort reason区分，并保存 ProviderFailureKind、retry reason/count与terminal cause。

- create/publish product-owned overhead预算：每 turn不超过15秒；
- run product-owned overhead预算：不超过10秒；
- 任一 wall time超过120秒必须由持久 timeline定位并继续收敛，或以明确 external provider limitation报告。

同 session continuation、进程重启后 authoring recovery、重复 publication/run request 与 pending tool result first-delivery均需验证。不得用删除 proof/freeze/recovery降低时延。

## 7. Evidence 与隐私

Track report允许命令形状、版本、脱敏 provider identity、阶段用时、stable diagnostic、session/revision/receipt/instance/run IDs、文件数量和 digest。禁止 credential、Authorization header、完整 provider request/response、raw reasoning、用户 HOME绝对路径和临时 provider config内容。

## 8. Codument compatibility

当前仓库 `codument/config/modeling.xnl` 明确 `enabled=false`，本 track不创建 modeling delta。Track、decision与behavior assets仍必须通过当前可用的 strict/decision验证；仅对确认属于 workspace std版本差异且与本track无关的既有发现单独记录。
