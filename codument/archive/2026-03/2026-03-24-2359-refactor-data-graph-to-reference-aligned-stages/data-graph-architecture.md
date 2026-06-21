# Target Architecture

## Architecture Principle

目标架构不是“把 Rx pipeline 换个语法重写”，而是：

1. 事件规范对齐参考项目
2. 执行模型维持 `DataGraph`
3. UI 消费升级为 graph projection
4. 先冻结契约与测试，再收敛正式架构并删除旧路径

核心结构：

`ingress -> lexical graph -> syntactic graph -> semantic graph -> projection graphs`

## Package Placement

### `cell/packages/core-contract`

这里应成为 stage event contract 的正式来源，建议新增或重组：

1. `src/stream/lexical.ts`
2. `src/stream/syntactic.ts`
3. `src/stream/semantic.ts`
4. `src/stream/transcriptNaming.ts`
5. `src/stream/common.ts`

第一阶段建议以独立目录或独立入口新建，不直接替换现有 `StreamEvents.ts`。

### `cell/packages/core-logic`

这里承载通用流阶段逻辑。当前正式实现已收敛到 `stream/*`，核心入口为：

1. `src/stream/IngressStreams.ts`
2. `src/stream/pipeline/createLLMStagePipeline.ts`
3. `src/stream/pipeline/LiveLLMStagePipeline.ts`
4. `src/stream/transcript/StageTranscript.ts`
5. `src/stream/testing/referenceAlignedStageScenario.ts`
6. `src/stream/runtime/SemanticRuntimeSupport.ts`

职责边界：

1. `IngressStreams`
   - 承载 provider ingress 进入 stage pipeline 之前的 canonical ordered ingress channels
   - 以 `timeline` 作为 lexical 阶段的正式顺序来源
2. `createLLMStagePipeline`
   - 接收 provider ingress
   - 组装 `IngressStreams.timeline -> semantic graph` 的正式桥接
3. `LiveLLMStagePipeline`
   - 增量完成 lexical -> syntactic -> semantic 阶段推进
   - 负责 quote / unquote / structured node / tool delta 聚合 / parser error
4. `StageTranscript`
   - 为阶段 fixture 与回放验证提供 transcript 结构

### `cell/packages/organ-logic`

这里承载 semantic projector 和更高层 runtime bridge。当前正式实现以 semantic-first 为准：

1. `src/stream/IngressStreamRuntime.ts`
2. `src/stream/IngressStreamAdapter.ts`
3. `src/stream/semantic/LLMSemanticProjector.ts`
4. `src/stream/SemanticStreamPipeline.ts`

语义边界：

1. `IngressStreamRuntime` / `IngressStreamAdapter` 只负责把 provider 输出收敛为 `IngressStreams`
2. semantic 层对齐参考项目
3. runtime 与上层消费以 semantic 作为 canonical event，不再保留 biz canonical projection

### `terminal/packages/organ` / `terminal/packages/tui`

终端层应改为消费 semantic-driven projection graph，而不是直接拼旧事件层。第一阶段建议新建：

1. `TuiCardGraph.ts`
2. `TuiTextGraph.ts`
3. `TuiProjectionGraph.ts`
4. `TextualProjectionGraph.ts`

且两种 projector 都必须有独立 fixture 和测试。

命名约定补充：

1. `TuiCardGraph`
   - 对齐参考项目 TUI 的 `card pipeline`
   - 消费新的 semantic canonical events
   - 产出 actor-scoped card / UI events
2. `TuiTextGraph`
   - 在本项目中承载 TUI 的 text snapshot graph
   - 与 `TuiCardGraph` 并列消费新的 semantic canonical events
   - 产出 actor-scoped text snapshot
3. `TuiProjectionGraph` / `TextualProjectionGraph`
   - 保留为本项目 terminal projection surface
   - 不替代 `TuiCardGraph` / `TuiTextGraph` 作为本项目终端 graph 的正式命名

## DataGraph Modeling

建议的 canonical stage flow：

1. ingress nodes
   - `ingress.provider_chunk`
   - `ingress.input`
2. lexical nodes
   - `lexical.input`
   - `lexical.event`
   - `lexical.seq`
   - `lexical.context`
3. syntactic nodes
   - `syntactic.input`
   - `syntactic.event`
   - `syntactic.seq`
   - `syntactic.parse_state`
   - `syntactic.tool_accumulator`
4. semantic nodes
   - `semantic.input`
   - `semantic.event`
   - `semantic.seq`
5. projection nodes
   - `projection.tui_text_snapshot`
   - `projection.tui_card_event`
   - `projection.textual_snapshot`
   - `projection.transcript_record`

重要规则：

1. 每一层只消费上一层的正式 event
2. 不允许 semantic 直接读取 lexical raw chunk
3. 不允许 projector 直接读取 parser state
4. 不允许任何 terminal/projector 绕过 semantic 直接消费 syntactic

## Transcript Alignment

长期应有正式 stage transcript：

1. `lexical.txt`
2. `syntactic.txt`
3. `semantic.txt`
4. `tui.txt`
5. `textual.txt`

测试 fixture 也应直接使用以上正式命名，不再保留 `.next` 过渡后缀。

`StreamTranscript` / `StreamLogger` 属于底层通用 transcript 序列化基础设施，不表达也不绑定 `ingress -> lexical -> syntactic -> semantic -> projection` 的上层阶段顺序。
