# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】Capsule 形态采用程度
- 背景：参考模式中 capsule = core_logic + types/ + adapter_registry + adapters/ + internals/。本项目 contract 与 logic 已包级分离。
- 选项：
  - A) 完整采用（含 types/）
  - B) 完整采用但去掉 types/，类型只在对应 contract 包定义
  - C) 仅做分层不引入目录约定
- 用户答复：在完整采用基础上去掉 types 部分；本项目 contract 和 logic 包级别就分开了，不需要在 logic 包中再定义 types（2026-06-11）。
- 最终决策：B
- 决策理由：避免 contract 包与 capsule types 双真相源；与 DataSubgraphContract/boundary declaration 的宿主分层一致。
- 状态：accepted

### 2. 【P0】Derivation contract 应用范围
- 背景：数据图加工定义进 contract、流转布线通用化的拆分模式，可全量或渐进应用。
- 选项：
  - A) 三集群 reducer/projection 全部采用
  - B) 首批仅 engine reducer + driver scheduler signal
- 用户答复：三集群的 reducer/projection 全采用（2026-06-11）。
- 最终决策：A
- 决策理由：本 track 就是完整重构步；全量采用避免二次返工。
- 状态：accepted

### 3. 【P0】AiRuntimeTurnSupervisor 处置
- 背景：原前提是"未接线 guardrail 代码（仅测试引用）"。**T4.3 实施时证伪**：它已接线进 TerminalRuntime 的 live turn 主路径（每 turn 订阅 history 事件、注入 runtime hint、驱动最多 3 轮 supervisor continuation），exec surface 还消费其 warning 回调。删除属于行为变更，与本 track"纯结构重构"非目标冲突。
- 选项：
  - A) 随本 track 删除（原决策，基于错误前提）
  - B) 本 track 保留，删除归入 refactor-ai-turn-tool-provider-lifecycle（Track-5），在修复重复读根因的同时移除该 guardrail
- 用户答复：先选 A（2026-06-11，基于"未接线"前提）；前提证伪后改选 B（2026-06-11）。
- 最终决策：B
- 决策理由：本 track 保持行为不变；该 guardrail 是 mission 否决的方向，但在 Track-5 完成主干语义修复（tool result truth / turn state 边界）之前移除会让重复读问题失去唯一的运行时缓解。Track-5 的输入需包含：移除 supervisor 接线（TerminalRuntime.ts:1243-1281 的 continuation 循环）、exec 回调、cell 侧导出与单元测试。
- 状态：accepted（前提修正后重确认）

### 4. 【P0】流转布线：vendor 原语优先、盘点先行
- 背景：derivation 需要 reduce→{state,effects}→project 的通用流转；存在新建平行 store 的诱惑。
- 最终决策：P1 先盘点 depa-data-graph / depa-actor 既有原语，结论记入 analysis；仅在确认缺失后允许在 platform 侧加薄 glue（类型+断言形态）；spec case 以源码级断言禁止控制面本地平行框架。
- 决策理由：vendor-primitives-first 吸引子；前置 track 的 reuse-vendor-adapter 断言已建立同类先例。
- 状态：accepted

### 5. 【P1】capsule 文件命名
- 背景：参考模式为 Python snake_case（core_logic.py）；本仓库 TS 文件混用 PascalCase/camelCase。
- 最终决策：camelCase——`coreLogic.ts`、`adapterRegistry.ts`，capsule 目录名 `<cluster>Capsule/`。
- 决策理由：与仓库内非类文件的主流命名一致；目录后缀 Capsule 显式标识形态。
- 状态：accepted（评审时可推翻）
