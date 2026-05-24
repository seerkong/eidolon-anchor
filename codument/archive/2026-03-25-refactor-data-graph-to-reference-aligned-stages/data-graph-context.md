# Current vs Reference Context

## Current Project

当前项目主链路可以概括为：

1. LLM / runtime 产出四路 ingress stream：
   - `control`
   - `think`
   - `content`
   - `tool`
2. `IngressStreams.timeline` 负责顺序。
3. 历史旧链路曾在单个语义 graph 中同时承担：
   - 文本标记解析
   - quote / unquote 识别
   - xml / json tool-call 识别
   - semantic event 生成
4. 历史终端链路曾通过旧 terminal graph 直接消费压缩后的事件面。

当前实现最强的部分是执行模型：

1. `DataGraph` 是显式、可批处理、可观察的图式执行内核。
2. `IngressStreams.timeline` 已经解决多路流顺序一致性。

当前实现相对参考项目的不足：

1. 缺 lexical stage
2. 缺 syntactic stage
3. 旧主链路职责混层
4. 历史测试夹具主要覆盖 `ingress.txt`、`semantic.txt`、`tui.txt`，缺少 lexical/syntactic 一等测试面

## 参考项目

参考项目中已经具备更成熟的三层事件契约和阶段边界：

1. lexical：
   - `lexical_turn_start`
   - `lexical_thinking_start/delta/end`
   - `lexical_content_start/delta/end`
   - `lexical_unquote_start/delta/end`
   - `lexical_tool_call_start/delta/end`
   - `lexical_usage`
   - `lexical_stop`
   - `lexical_error`
2. syntactic：
   - `syntactic_thinking_start/delta/end`
   - `syntactic_content_start/delta/end`
   - `syntactic_tool_text`
   - `syntactic_quote`
   - `syntactic_structured_node`
   - `syntactic_tool_call`
   - `syntactic_error`
3. semantic：
   - user input
   - turn start / end
   - think start / delta / end
   - content start / delta / end
   - quote
   - tool call planned / start / result
   - questionnaire request / result
   - actor spawned / actor state
   - mailbox / inbox
   - task state / task board
   - plan approval request / result
   - shutdown request / result
   - background result
   - team status
   - notice
   - error

参考项目里“何时发事件”是正式契约：

1. lexical event 在 provider chunk 到达时立即产生
2. syntactic event 在结构被解析出来时产生
3. semantic event 在 syntactic event 被解释为产品语义时产生

## Alignment Scope

本 track 必须与参考项目完全对齐的内容：

1. lexical event 家族
2. syntactic event 家族
3. semantic event 家族
4. event field naming
5. event construction rules
6. stage transition timing
7. transcript stage naming

本 track 不需要原样照搬的内容：

1. Rx observable API
2. Python event bus runtime 容器
3. Python TUI UI 代码
4. Python dataclass 形式

## Delivery Order Constraint

这次 track 的交付顺序必须满足：

1. P1 先冻结契约与 guardrail
2. 只有当新链路整条数据链路测试全部通过后，才允许切换正式调用方
3. 切换后应继续删除旧压缩路径与兼容残骸
