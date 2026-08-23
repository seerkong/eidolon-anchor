# Proposal：验证完整 AIAgentDefinition 与 Ctrl/Data workflow 产品闭环

## 背景

depa-flows 已发布完整 `AIAgentDefinition` executable projection；Eidolon 也已经把 schema、effect policy、Material values、exact tools 与 output validation 接入通用 actor runtime，并通过资源 fixture 验证 Ctrl/Data 两个 profile 使用同一执行链路。剩余缺口是作者态到产品运行态的最终证据：用户必须能依据已安装的 Authoring/Resource DSL/Flow DSL Skills 编写完整 ResourcePackage，明确发布后，分别运行 `AICtrlWorkflow` 与 `AIDataWorkflow` 并得到可恢复、可复用且 schema-valid 的结果。

## 目标

- 从安装后的系统 Skills 渐进读取 AIAgentDefinition、Resource DSL 与 Flow DSL 规范，创建完整 ResourcePackage。
- ResourcePackage 显式包含 App、Ctrl/Data workflows、AIAgentDefinition、ordered Messages、Input/Output schema、EffectPolicy、MaterialPort、MaterialBinding 与 Material values。
- 两个 workflow 通过 exact `AIAgentTask` 四元组引用同一 Agent；不新增 substrate node 或 host 侧语义推断。
- 作者态、proof、publication、registry readback、instance/run、result 与 recovery 形成一条可核对的产品链路。
- 验证重复调用与进程恢复复用同一 generic effect lifecycle 结果，不生成第二 provider child。

## 非目标

- 不新增 workflow-specific actor、session、history、compactor、resource registry 或 provider loop。
- 不通过自然语言、节点名、App/workflow 名、正则、关键词、substring、alias 或顺序特征决定工具或执行语义。
- 不把 `AIAgentTask` 增加为 WorkCtrlFlow/AIDataWorkflow substrate node；它保持资源运行选择的 exact typed tuple。
- 不自动授权 publication 或 execution；两者继续是独立产品事实。
- 不复用 child conversation history 作为跨 turn、重复调用或恢复 authority。

## 变更内容

- 新增作者态到 Ctrl/Data runtime 的完整产品验收 fixture、tests 与脱敏 evidence。
- 必要时只修复该 journey 暴露的通用 schema、resource adapter、actor/effect lifecycle 或 CLI/TUI 接缝。
- 将已完成的 runtime track 与 mission 状态对齐，并以 fresh coding AttractorCheck 收口。

## 影响范围

- behavior：`eidolon-complete-agent-ctrl-data-e2e`
- 代码与测试：workflow authoring/publication、Halfcode-backed registry、generic Agent runtime、Ctrl/Data runtime、CLI/TUI/native read paths
- 文档：本 track 的设计、findings 与最终验收报告
