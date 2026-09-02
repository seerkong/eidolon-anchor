# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】首批 components 是否包含 SessionDomain
- 背景：track 创建时首批为 8 个 components，缺 SessionDomainDataComponent。但 provider context 的合法输入规则需要 Session Domain active binding 参与表达，且 session head 解析的优先级歧义（prompt target 引用 vs declared history head）是已确认的边界事故来源之一。
- 选项：
  - A) 补入 SessionDomainDataComponent，作为首批第 9 个 component
  - B) 推迟到 conversation spine track
- 最终决策：A
- 决策理由：没有 Session contract，规则"provider context 只能来自 LLM Context + History active tail + Session active binding"无法完整表达；head 解析唯一规则也无处声明。补入成本低。
- 状态：accepted

### 2. 【P0】Checkpoint / Journal / DerivedIndex 的 contract 覆盖范围
- 背景：路线图层面曾要求为 Checkpoint、Journal、DerivedIndex 提供最小 contract；track 创建时只用 fact grade 与 Not Owned Here 断言覆盖。历史事故中 VM snapshot 文件曾泄漏完整 LLM/tool payload，根因是 snapshot 内容没有声明 owner。
- 选项：
  - A) CheckpointSnapshot 补最小 owner contract（只声明 snapshot 内容归属与反边界，不实现 writer）；AppendOnlyJournal 与 DerivedIndex 显式推迟到 persistence backplane track
  - B) 三者都补完整 component contract
  - C) 三者都只用 fact grade 覆盖
- 最终决策：A
- 决策理由：snapshot 内容 owner 缺位有真实事故证据，必须现在声明；journal/index 的误用已被负向断言覆盖，完整 contract 属于 persistence backplane 范围，现在做会扩大 track 边界。
- 状态：accepted

### 3. 【P0】通用 contract shape 的宿主包
- 背景：DataSubgraphContract shape 与 fact grade 是领域无关机制，具体 data components 是 AI 领域语义。需避免在 platform 与 AI 两侧平行维护两份 shape 定义。
- 选项：
  - A) 通用 shape 与 fact grade 放 `platform-contract`，具体 AI components 放 `ai-core-contract`
  - B) 全部放 `ai-core-contract`，未来有第二领域再上移
- 最终决策：A
- 决策理由：`platform-contract` 是已存在的平台协议边界包，放入 contract 类型不违反"无证据不建 platform-logic"的 gate（这是 contract 不是 logic）；双层微内核要求平台机制与领域语义分层。
- 状态：accepted

### 4. 【P1】LLM Context contract 与现有 prompt domain 的关系
- 背景：conversation runtime 的 prompt domain 已有 generation/basis/transform/overlay/materialized context 概念。若 LLM Context contract 只按 work-context overlay 视角描述，会造出与现有三域平行的第二套 LLM Context 描述。
- 最终决策：LLM Context contract 必须复用现有 prompt domain 概念（generation、basis 引用 history generation、transform、overlay、materialized context），work context overlay 是其中一种 transform，不是独立模型。
- 状态：accepted
