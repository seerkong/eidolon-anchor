## 上下文

当前项目已经拥有更高级的 `DataGraph` 执行模型和顺序化的 `IngressStreams.timeline`，但事件分层仍明显弱于参考项目。用户要求本次改造必须满足两个同时成立的条件：

1. 事件定义、产生时机、构造字段与参考项目完全对齐
2. 新实现仍基于本项目的 `DataGraph`

此外，用户后续已经明确接受 breaking change：在 P1 契约和测试闭环建立后，应尽快把主链路切到新实现，并删除旧兼容路径，而不是长期保留双轨。

## 方案概览
1. 先冻结 canonical 契约
  - 在 track 内以自包含文档固化 lexical / syntactic / semantic 三层目标
  - 明确 P1 先冻结契约与测试面，随后直接推进主链路切换
2. 建立并收敛正式实现
  - 在 `core-contract` 中新增三层事件契约
  - 在 `core-logic` / `organ-logic` 中将新实现收敛到正式 `stream/*` 命名空间
  - 让 canonical replay 与 live/runtime 共享同一套 `ReferenceAlignedStageDataGraph` 阶段内核，live 侧只负责 `ingress -> lexical` 适配
  - 让 terminal runtime 的 direct slash 可见输出也进入 canonical semantic runtime bus 与 history，而不是只在 bridge 内部构造可见文本
  - 在 `terminal/packages/organ` 中新增 TUI / Textual / card / text projection graphs
3. 建立完整测试闭环
  - lexical fixtures / tests
  - syntactic fixtures / tests
  - semantic fixtures / tests
  - TUI projection fixtures / tests
  - Textual projection fixtures / tests
  - TuiCardGraph / TuiTextGraph fixtures / tests
4. 测试闭环通过后直接切主链路
  - 切换内部测试、terminal 消费入口、runtime 主 pipeline
  - 删除旧压缩路径与兼容层

## 影响范围与修改点（Impact）
- 受影响的文件/模块：
  - `cell/packages/core-contract`
  - `cell/packages/core-logic`
  - `cell/packages/organ-logic`
  - `backend/packages/composer`
  - `backend/packages/core`
  - `backend/packages/organ`
  - `terminal/packages/organ`
  - `terminal/packages/tui`
  - `terminal/packages/support`
  - `terminal/packages/cli`
- 本 track 的补充文档：
  - `./data-graph-overview.md`
  - `./data-graph-context.md`
  - `./data-graph-architecture.md`
  - `./data-graph-migration.md`

## 决策
- 决策：P1 先冻结契约与 guardrail，P2 起按 breaking-change 路线直接收敛到新主链路
- 理由：用户先要求“先测通再迁移”，随后又明确要求“最激进、最干净”且不保留兼容代码，因此当前方案应以快速切换和删除旧路径为准

- 决策：TypeScript 事件契约与时机以参考项目为唯一语义来源
- 理由：用户明确要求“事件定义和产生时机、构造等，要完全对齐参考项目”

- 决策：执行内核继续使用 `DataGraph`
- 理由：本项目的显式图模型比参考项目的 stream object 方案更高级，且用户明确希望保留

- 决策：对齐参考项目 TUI 消费图的新增命名采用 `TuiCardGraph` 与 `TuiTextGraph`
- 理由：`TuiCardGraph` 更准确表达“对齐 card pipeline 的 actor event 投影”；`TuiTextGraph` 在本项目中明确表示“与 card graph 并列、直接消费 semantic 的 text snapshot graph”

- 决策：本项目中的 `TuiCardGraph` 与 `TuiTextGraph` 采用并列消费 semantic 的结构
- 理由：这是当前 track 内的项目级落地要求；即使参考项目的数据流表现为 `semantic -> card -> text`，本项目仍要求两个 graph 共享 semantic 作为底层公共流

- 决策：`AgentEventGraph` 改为 semantic-first runtime bus，历史压缩事件面不再作为运行时主载荷
- 理由：用户已经明确接受 breaking change，且要求尽早完整迁移到新链路；继续以历史压缩事件面作为 runtime 主总线只会把旧链路留在系统中心

- 决策：runtime、turn bridge 与 notification bridge 只能共享一条 canonical semantic source
- 理由：terminal 如果再从 ingress 旁路重建一份 semantic event，会让 runtime bus 与终端显示出现双路径和时机漂移，不符合 semantic-first cutover 的单源目标

- 决策：direct slash 的正式可见输出也必须经由 canonical semantic runtime bus
- 理由：只把 slash 结果直接塞进 terminal bridge 会让用户可见输出脱离 event bus、message history 与 replay 面，继续在正式链路里保留例外通道

- 决策：`getTuiRuntimeBridge` 与 Textual 对应 bridge 必须按 projection 明确选择正式输出面
- 理由：`TextualProjectionGraph` 不能只停留在测试和 hub 内部；track 既然声明 TUI / Textual 都是正式消费图，就要有可到达的 runtime public entry

- 决策：live/runtime 不再维护独立的 syntactic / semantic imperative parser，而是先产出 lexical events，再复用 canonical replay 的 `ReferenceAlignedStageDataGraph`
- 理由：只有这样才能把 “stage-based DataGraph” 从 replay 侧承诺真正扩展到 runtime 主链，并用 parity gate 锁定 live/replay 的阶段输出一致

- 考虑的替代方案：直接在历史旧入口上逐步打补丁
- 理由：会在尚未完成契约和测试闭环前污染主链路，不满足当前 track 的 phase-1 guardrail 要求

## 风险 / 权衡
- 风险：阶段性命名和文档可能滞后于最终代码收敛
  → 缓解措施：在主链路切换后，统一把实现、测试、配置和文档收敛到正式 `stream/*` 命名，并删除过渡名称

- 风险：只对齐事件名而未对齐事件产生时机
  → 缓解措施：把 transcript fixtures 与多阶段测试写入计划的第一道 gate

- 风险：runtime bus 与 terminal bridge 各自重建 semantic 事件，导致行为靠去重逻辑勉强维持一致
  → 缓解措施：terminal 只订阅 canonical semantic source，移除 direct stream 双路径与 skip-replay 补洞逻辑

- 风险：TUI 与 Textual 两套 projector 增加测试面
  → 缓解措施：将两套 projector 都视为第一阶段必选项，而非后补增强项

## 兼容性设计
- 当前阶段已不再以兼容为目标；runtime 主链路优先切换到 semantic-first
- 旧兼容代码不再保留；历史兼容层与旧 runtime 事件面应直接删除，而非继续隔离保留

## 迁移计划
1. 冻结契约与阶段 fixture
2. 建立 lexical / syntactic / semantic / terminal graphs
3. 切换 runtime、terminal、history 与测试到 semantic-first 正式链路
4. 删除旧压缩路径与兼容层

## 待解决问题
- provider ingress 到 lexical event 的最细粒度映射是否需要在第一阶段直接覆盖 usage / stop / error 全量场景
- `.next` transcript fixture naming 何时收敛为无后缀正式命名
