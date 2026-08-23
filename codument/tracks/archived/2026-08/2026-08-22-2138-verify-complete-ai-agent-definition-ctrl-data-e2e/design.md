# Design：完整 Agent 作者态、Ctrl/Data 与 E2E 验收

## 1. Authority 与集成边界

```text
installed Skills
  -> ResourcePackage authoring workspace
  -> exact Halfcode/depa publication proof
  -> workspace ResourcePackage atomic publication
  -> admitted registry snapshot
  -> Ctrl/Data exact AIAgentTask tuple
  -> generic AgentExecutionContract
  -> generic actor/provider/tool/effect lifecycle
  -> schema-valid result + durable evidence
```

Halfcode 持有 ResourcePackage、Catalog、KindDefinition、layer、content identity 与 dependency snapshot。depa-flows 持有 App/Workflow/AIAgentDefinition/Material 投影以及 run-freeze 语义。Eidolon 只持有 host roots、作者态事务、publication fence、通用 actor/provider/tool/effect/session 与产品入口。

## 2. 完整作者态资源

隔离 workspace 的 ResourcePackage 必须由已安装 Skills 指导生成，并包含所需 exact KindDefinitions、App、Ctrl/Data workflows、带 ordered Messages 的 `AIAgentDefinition`、Message/Input/Output JSON schemas、closed `EffectPolicy`、`MaterialPort`、task-specific `MaterialBinding`、typed Material value，以及两个 profile 各自的 flow-code 与 exact Agent task tuple。

Fresh 产品验收从没有 workspace `manifest.xnl` 的空资源根开始。模型先按已安装 Authoring、Halfcode Resource DSL 与 Flow DSL references 生成完整文件集，再通过独立的 `WorkflowCreateResourcePackageSession { files: [...] }` 建立可恢复作者态。该工具只接收封闭的 exact path/content 列表并复用既有 `explicit-complete-package` whole-package loader；它不合成 KindDefinition、不选择资源语义、不建立第二 registry。已有 workspace package 仍使用 `WorkflowOpenAuthoringSession` 的 `workspace-layer` 分支。

作者态只能编辑可解码的 UTF-8 authority；opaque bytes必须逐字节保留。prepare/publish必须绑定whole-package revision、registry/composition revision、workflow profile proof、Agent/Material projection与dependency closure。只有admitted snapshot中的record可以产生`resource://` publication fact。

## 3. AIAgentTask 与 workflow profile

`AIAgentTask` 是资源选择契约，不是新的 flow node。固定四元组为 `workflowKind`、`workflowRef`、`nodeId`、`agentDefinitionRef`。Ctrl profile由它的Run/effect node携带该tuple；Data profile由它的TransformNode/effect node携带同一形状。两个profile的substrate lifecycle保持独立，但共享同一个registry adapter、run freeze、`AgentExecutionContract`、effect lifecycle、delegate actor、tool registry、snapshot repository与output validator。

任何类似名称、中文普通文本或嵌入正文的`resource://...`都不得形成task、tool、policy或Material binding；只有固定结构节点和exact refs生效。

## 4. 执行与重复调用语义

每个 workflow instance/run 是独立运行事实。对同一 `runId + generation + effectId` 的重复 invoke，通用 runtime-control effect lifecycle 是唯一 authority：pending时同实例或新provider实例等待同一终态；completed时回放同一result；恢复时从持久request/pending/result evidence继续；任一authority字段不一致时fail closed。

这里的“重复”是同一 effect identity 的重试、恢复或重复递交，不是把一个已经完成的业务任务当作全新的 run。用户显式创建新的 run identity 时，应得到新的运行事实。

## 5. Schema、policy 与 Material

Adapter从同一admitted snapshot + depa projection/freeze receipt构造closed、deep-frozen `AgentExecutionContract`。input、ordered messages、Material values在provider前验证；`declared-only`只允许exact ToolRefs，`none`必须为空且与ToolRefs冲突时拒绝。output在generic completion seam验证，raw string失败后最多一次JSON parse；若raw string通过则typed result是该string，若parsed value通过则typed result是deep-frozen parsed value。仍不符合schema时不得写成功result/effect fact。Ctrl与Data effect adapter都消费这个同一typed result，不能让Data substrate再次自行解析provider文本。

actor create、snapshot serialize、hydrate都必须通过同一core closed normalizer，使等待与恢复后的contract不可漂移。旧snapshot缺contract保持兼容；存在malformed contract的snapshot fail closed。

## 6. 产品 harness

P1/P2使用deterministic provider和完整物理ResourcePackage锁定精确行为与故障边界。P4至少执行一次当前compiled/local `eidolon`的隔离journey：新HOME/global与空workspace资源根，`global init`安装exact四Skill，由installed references创建完整package，再prove、publish并显式执行Ctrl/Data。provider配置只作为临时只读输入，不把credential、prompt、reasoning或完整输出写进报告。

授权顺序保持独立：create/prove不发布，publish不执行，Ctrl/Data run分别显式授权。外层CLI session可以延续；每次Workflow child可以是fresh actor，跨turn只消费owner-store typed facts，不依赖child history。

## 7. 修复边界与版本

允许修复generic schema、Skill reference、Halfcode/depa adapter、actor snapshot、effect lifecycle、CLI/TUI/native read model。禁止新增任何自然语言/名称/label/regex/keyword/substring/fuzzy/ordered/alias语义路由，也禁止第二registry/scanner/dependency resolver、workflow-specific runtime或手工Flow DSL副本。

测试与报告使用“边界用例”“异常输入验证”“健壮性验证”等中性表述。系统Skills只在内容变化时按`1.0.x`增长最小patch；不得修改npm registry配置或使用`--registry`。
