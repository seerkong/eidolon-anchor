# Design

## 现有链路与映射
ProviderRuntimeLlmAdapter -> createProviderStreamWithRetry -> driver/transport。AiAgentExecutor.streamProviderCompletion -> processStreamFn -> fresh ingress/semantic pipeline -> 完成assistant msg -> tool dispatch。shared leaf由streaming/cooperative共用。低层不能在同一解析器拼接第二次输出。

## 预算
默认保留3次重试、1/2/4秒+jitter、单次cap。120秒约束累计退避等待，不把首次请求时间算作退避；request elapsed另行观测。显式finite maxTotalElapsedSeconds/operation deadline和AbortSignal仍有最终裁决权，请求自身保留transport/actor超时。不是把120改成更大魔数。等待前后检查abort/deadline。

## 单一恢复owner
仅在executor已知Chat完成边界启用local-only恢复owner，使adapter低层不另开重试；上层retryable transport/status失败重新执行完整completion，重建解析器，使用相同messages/tools/prompt。不向provider wire发送owner标记。Responses及未知adapter保守保持旧边界。
安全证明：runOneCompletion失败时未返回assistant msg、未进入工具派发；partial tool JSON仍是临时累加器。成功后才提交canonical及执行工具。旧文本/思考可以是中断attempt观察，但不可并入成功message；StreamEnd/Start分隔。
reasoning-only/truncated/invalid-tool-payload仍交原语义恢复，不混入transport retry，不改变max_tokens。

## 实现验证中的纠偏
真实 ingress 测试证明仅重建解析器不足：MessageHistoryGraph 的 pendingAssistant 会把失败文本并入重试，actor 交错还会提前提交。新增 semantic_provider_attempt_started/succeeded/aborted，附 attempt_id；纯历史 reducer 按 actor 暂存本次输出，成功才回放到原单写者逻辑，中止丢弃。UI 仍直接消费语义流，不延迟流式显示。旧无 attempt 边界的来源及旧 assembly state 保持兼容；首尾时间戳保留，token delta 合并减少对象数量；terminal/complete 释放暂存。
ShellRuntimeSupport 等待 adapter 与 pipeline 都终止再发 terminal，避免旧 pipeline 事件串入下一次尝试。
上层重试通过 local-only callToken/attemptNumber 保持同一逻辑 providerCall 的观测关联；adapter 用 WeakMap 保存 token 到诊断 identity 的关联，既不改变 wire，也不持久保留 token。语义修复诊断仍只由原 semantic owner 发布。

## 诊断
复用session DiagnosticEvent sink记录actor/operation、attempt、分类、退避、累计等待、elapsed和停止原因；沿现有错误清洗，不记录密钥/请求体；禁用日志时保持禁用。

## 验收与风险
测试先行：长首请求、指数等待、取消/期限、401/400不重试、partial reasoning/content/tool JSON后成功只执行一次、未移交owner低层仍拒绝已输出重放、streaming/cooperative、诊断回读。先故障模拟，不付费，不能宣称中转故障消失。最终fresh方向审查。回滚owner交接/helper，不迁移既有session数据。
